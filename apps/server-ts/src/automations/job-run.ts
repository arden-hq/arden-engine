import { Clock, Effect } from "effect"
import type { ChatMessage } from "../chat/message.js"
import type {
  AutomationQueue,
  TerminalAutomationChatRun
} from "../persistence/automations/queue.js"
import {
  jobHandlerItem,
  type AutomationJobLease,
  type AutomationJobOutcome,
  type AutomationJobSettlement
} from "../persistence/automations/store.js"
import {
  awaitEnded,
  jobResult,
  startAutomationRun,
  type AutomationRunner,
  type AwaitAutomationRun
} from "./runner.js"
import { ChatMessageConflictError } from "../chat/message-errors.js"
import { TRANSIENT_RUN_ERROR_CODES } from "@arden-hq/protocol/chat"
import { JOB_RETRY_LADDER_MS } from "../persistence/automations/retry-ladders.js"

const COLLISION_RETRY_DELAY_MS = 1_000

/**
 * The one failure rule for every Automation run: a run that failed on a transient error and wrote
 * nothing is tried again after each delay of `JOB_RETRY_LADDER_MS`; anything else ends it. `again`
 * starts try number `tries` and waits for its end, or answers undefined when it could not start.
 */
export const retried = Effect.fn("Automation.retried")(function* <
  Ended extends TerminalAutomationChatRun,
  E
>(
  first: Ended,
  tries: number,
  again: (tries: number) => Effect.Effect<Ended | undefined, E>
): Effect.fn.Return<Ended, E> {
  let observed = first
  for (const [step, delay] of JOB_RETRY_LADDER_MS.slice(tries - 1).entries()) {
    if (observed.status !== "failed" || observed.wrote) break
    if (!TRANSIENT_RUN_ERROR_CODES.some((transient) => transient === observed.errorCode)) break
    yield* Effect.sleep(delay)
    const next = yield* again(tries + step + 1)
    if (next === undefined) break
    observed = next
  }
  return observed
})

/**
 * Starts a handler's one run in `run.sessionId`, or takes the run the job recorded, and waits for
 * its end by the failure rule; each retry is a new run in the same session.
 */
export const runByRule = Effect.fn("Automation.runByRule")(function* (
  services: {
    readonly chat: Pick<ChatMessage["Service"], "startAutomation">
    readonly awaitRun: AwaitAutomationRun
  },
  job: AutomationJobLease,
  run: { readonly sessionId: string; readonly prompt: string; readonly name: string }
) {
  const clientId = `automation-run-${job.payload.automationRunId}`
  const start = Effect.fn("Automation.runByRule.start")(function* (tries: number) {
    const receipt = yield* startAutomationRun(services.chat, job, {
      ...run,
      clientId: tries === 1 ? clientId : `${clientId}-retry-${tries - 1}`
    })
    if (receipt.runId === null) throw new Error(`${run.name} has no Run identity`)
    return receipt.runId
  })
  const ended = (runId: string) =>
    services.awaitRun(runId).pipe(Effect.map((observed) => ({ ...observed, runId })))
  const first = yield* ended(job.payload.chatRun?.runId ?? (yield* start(1)))
  return yield* retried(first, 1, (tries) =>
    start(tries).pipe(
      Effect.option,
      Effect.flatMap((runId) =>
        runId._tag === "None" ? Effect.succeed(undefined) : ended(runId.value)
      )
    )
  )
})

export const makeAutomationJobRunner = (services: {
  readonly chat: Pick<ChatMessage["Service"], "startAutomation">
  readonly queue: Pick<
    AutomationQueue["Service"],
    "prepareRunSession" | "prepareForkSession" | "prepareOwnChat" | "observeOccurrence"
  >
  readonly executeHandler: AutomationRunner
}): ((job: AutomationJobLease) => Effect.Effect<AutomationJobSettlement, Error>) => {
  const runSession = Effect.fn("AutomationJobRunner.runSession")(function* (
    job: AutomationJobLease
  ): Effect.fn.Return<string | undefined, Error> {
    if (job.payload.purpose === "space_review") return yield* services.queue.prepareRunSession(job)
    if (job.payload.contextMode === "fork") {
      return (yield* services.queue.prepareForkSession(job))?.sessionId
    }
    if (job.payload.chatKind === "yours") return yield* services.queue.prepareOwnChat(job)
    if (job.payload.sessionId === null) throw new Error("Automation has no Chat session")
    return job.payload.sessionId
  })
  return Effect.fn("AutomationJobRunner")(function* (
    job: AutomationJobLease
  ): Effect.fn.Return<AutomationJobSettlement, Error> {
    const checkpoint = jobHandlerItem(job.payload)
    const captured = job.payload.chatRun
    const handlerRunId = checkpoint?.runId ?? checkpoint?.previousRunId
    const bound =
      checkpoint !== undefined && handlerRunId != null
        ? {
            runId: handlerRunId,
            sessionId: checkpoint.input.sessionId,
            authority: captured?.authority ?? "revoked"
          }
        : captured
    if (job.payload.handler !== null && (bound === null || bound.authority === "active")) {
      return yield* services.executeHandler(job)
    }
    const sessionId = bound?.sessionId ?? (yield* runSession(job))
    if (sessionId === undefined) {
      return jobResult.withoutRun("no_change", "The chat has nothing to read yet")
    }
    if (bound === null) {
      const receipt = yield* startAutomationRun(services.chat, job, {
        sessionId,
        clientId: `automation-run-${job.payload.automationRunId}`,
        prompt: job.payload.prompt,
        name: job.payload.name
      }).pipe(
        Effect.catch((cause) =>
          cause instanceof ChatMessageConflictError && cause.kind === "session_busy"
            ? Effect.map(Clock.currentTimeMillis, (now) => ({
                status: "deferred" as const,
                cause: "session_busy" as const,
                reason: cause.message,
                retryAt: now + COLLISION_RETRY_DELAY_MS,
                sessionId
              }))
            : Effect.fail(cause)
        )
      )
      if ("status" in receipt && receipt.status === "deferred") return receipt
      if (receipt.runId === null) throw new Error("Automation Chat run has no identity")
    }

    const observe = () => awaitEnded(services.queue.observeOccurrence(job.payload.automationRunId))
    const once =
      job.payload.purpose === "task_execution" ||
      job.payload.purpose === "space_review" ||
      job.payload.handler !== null ||
      bound?.authority === "revoked"
    const first = yield* observe()
    const observed = once
      ? first
      : yield* retried(first, 1, (tries) =>
          startAutomationRun(services.chat, job, {
            sessionId,
            clientId: `automation-run-${job.payload.automationRunId}-retry-${tries - 1}`,
            prompt: job.payload.prompt,
            name: job.payload.name
          }).pipe(
            Effect.option,
            Effect.flatMap((started) =>
              started._tag === "None" ? Effect.succeed(undefined) : observe()
            )
          )
        )
    return {
      status: "ended",
      outcome: occurrenceOutcome(observed, {
        revoked: bound?.authority === "revoked",
        handler: job.payload.handler !== null
      }),
      result: observed.result,
      error:
        observed.blocked?.reason ??
        observed.error ??
        (job.payload.handler === null
          ? null
          : "Automation authority changed before handler completion"),
      chatRunId: observed.runId,
      chatSessionId: observed.sessionId
    }
  })
}

const occurrenceOutcome = (
  observed: TerminalAutomationChatRun,
  options: { readonly revoked: boolean; readonly handler: boolean }
): AutomationJobOutcome => {
  if (options.revoked) return "superseded"
  if (observed.status === "cancelled") return "cancelled"
  if (options.handler) return "failed"
  if (observed.status !== "completed") return observed.status
  if (observed.blocked === null) return "finished"
  return observed.blocked.kind === "needs_input" ? "needs_you" : "blocked"
}
