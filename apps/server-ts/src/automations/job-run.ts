import { Clock, Effect, Option } from "effect"
import { AUTOMATION_CHAT_CHOICE, AUTOMATION_CONTEXT_MODE } from "@arden-hq/protocol/automations"
import { JOB_PURPOSE } from "../persistence/job-classification.js"
import { OBSERVED_RUN } from "../persistence/automations/queue.js"
import { AUTOMATION_JOB_STATUS } from "../persistence/automations/store.js"
import { RUN_AUTHORITY_STATE } from "../persistence/sqlite/run-context.js"
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
  blockedOutcome,
  jobResult,
  startAutomationRun,
  type AutomationRunner,
  type AwaitAutomationRun
} from "./runner.js"
import { CHAT_CONFLICT_KIND, ChatMessageConflictError } from "../chat/message-errors.js"
import { TRANSIENT_RUN_ERROR_CODES } from "@arden-hq/protocol/chat"
import { JOB_RETRY_LADDER_MS } from "../persistence/automations/retry-ladders.js"

const COLLISION_RETRY_DELAY_MS = 1_000

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
    if (observed.status !== OBSERVED_RUN.failed || observed.wrote) break
    if (!TRANSIENT_RUN_ERROR_CODES.some((transient) => transient === observed.errorCode)) break
    yield* Effect.sleep(delay)
    const next = yield* again(tries + step + 1)
    if (next === undefined) break
    observed = next
  }
  return observed
})

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
        Option.isNone(runId) ? Effect.succeed(undefined) : ended(runId.value)
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
    if (job.payload.purpose === JOB_PURPOSE.spaceReview)
      return yield* services.queue.prepareRunSession(job)
    if (job.payload.contextMode === AUTOMATION_CONTEXT_MODE.fork) {
      return (yield* services.queue.prepareForkSession(job))?.sessionId
    }
    if (job.payload.chatKind === AUTOMATION_CHAT_CHOICE.yours)
      return yield* services.queue.prepareOwnChat(job)
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
            authority: captured?.authority ?? RUN_AUTHORITY_STATE.revoked
          }
        : captured
    if (
      job.payload.handler !== null &&
      (bound === null || bound.authority === RUN_AUTHORITY_STATE.active)
    ) {
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
          cause instanceof ChatMessageConflictError && cause.kind === CHAT_CONFLICT_KIND.sessionBusy
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
      if ("status" in receipt && receipt.status === AUTOMATION_JOB_STATUS.deferred) return receipt
      if (receipt.runId === null) throw new Error("Automation Chat run has no identity")
    }

    const observe = () => awaitEnded(services.queue.observeOccurrence(job.payload.automationRunId))
    const once =
      job.payload.purpose === JOB_PURPOSE.taskExecution ||
      job.payload.purpose === JOB_PURPOSE.spaceReview ||
      job.payload.handler !== null ||
      bound?.authority === RUN_AUTHORITY_STATE.revoked
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
              Option.isNone(started) ? Effect.succeed(undefined) : observe()
            )
          )
        )
    return {
      status: "ended",
      outcome: occurrenceOutcome(observed, {
        revoked: bound?.authority === RUN_AUTHORITY_STATE.revoked,
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
  if (observed.status === OBSERVED_RUN.cancelled) return "cancelled"
  if (options.handler) return "failed"
  if (observed.status !== OBSERVED_RUN.completed) return observed.status
  if (observed.blocked === null) return "finished"
  return blockedOutcome(observed.blocked)
}
