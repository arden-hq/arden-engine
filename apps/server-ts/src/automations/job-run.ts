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
import { awaitEnded, jobResult, startAutomationRun, type AutomationRunner } from "./runner.js"
import { ChatMessageConflictError } from "../chat/message-errors.js"
import { TRANSIENT_RUN_ERROR_CODES, type ChatRunErrorCode } from "@arden-hq/protocol/chat"
import { JOB_RETRY_LADDER_MS } from "../persistence/automations/retry-ladders.js"

const COLLISION_RETRY_DELAY_MS = 1_000

const isTransient = (code: ChatRunErrorCode | null): boolean =>
  TRANSIENT_RUN_ERROR_CODES.some((transient) => transient === code)

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
    let observed = yield* observe()
    for (const [index, delay] of JOB_RETRY_LADDER_MS.entries()) {
      if (job.payload.purpose === "task_execution" || job.payload.purpose === "space_review") break
      if (job.payload.handler !== null || bound?.authority === "revoked") break
      if (observed.status !== "failed" || observed.wrote || !isTransient(observed.errorCode)) break
      yield* Effect.sleep(delay)
      const started = yield* startAutomationRun(services.chat, job, {
        sessionId,
        clientId: `automation-run-${job.payload.automationRunId}-retry-${index + 1}`,
        prompt: job.payload.prompt,
        name: job.payload.name
      }).pipe(Effect.option)
      if (started._tag === "None") break
      observed = yield* observe()
    }
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
