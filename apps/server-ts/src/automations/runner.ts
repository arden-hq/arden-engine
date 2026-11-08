import { Effect } from "effect"
import type { ChatMessage } from "../chat/message.js"
import { ChatMessageError, type ChatMessageFailure } from "../chat/message-errors.js"
import type { HandlerItemRef } from "../persistence/automations/handler-item.js"
import type { AutomationJobLease, AutomationJobResult } from "../persistence/automations/store.js"
import type { TerminalAutomationChatRun } from "../persistence/automations/queue.js"
import type { ChatReceipt } from "@arden-hq/protocol/chat"
import { automationModelSelection } from "./model-selection.js"
import { iso } from "../runtime/clock.js"

export type AutomationRunner = (
  job: AutomationJobLease
) => Effect.Effect<AutomationJobResult, Error>

export class PlanLimitPause extends Error {
  constructor(
    readonly sessionId: string,
    readonly until: number
  ) {
    super(`Paused on a plan limit until ${iso(until)}`)
  }
}

export const awaitEnded = Effect.fn("Automation.awaitEnded")(function* <
  Ended extends TerminalAutomationChatRun,
  E
>(
  observe: Effect.Effect<
    | { readonly status: "running" }
    | { readonly status: "paused"; readonly sessionId: string; readonly until: string }
    | Ended
    | null,
    E
  >
): Effect.fn.Return<Ended, E | PlanLimitPause> {
  while (true) {
    const observed = yield* observe
    if (observed === null) throw new Error("Automation Chat run disappeared")
    if (observed.status === "paused")
      return yield* Effect.fail(new PlanLimitPause(observed.sessionId, Date.parse(observed.until)))
    if (observed.status !== "running") return observed
    yield* Effect.sleep("250 millis")
  }
})

export const isNoModelProvider = (cause: unknown): cause is ChatMessageError =>
  cause instanceof ChatMessageError && cause.reason === "unavailable"

export type AwaitAutomationRun = (runId: string) => Effect.Effect<TerminalAutomationChatRun, Error>

interface JobRunRef {
  readonly chatRunId: string | null
  readonly chatSessionId: string | null
}

export const NO_CHAT_RUN: JobRunRef = { chatRunId: null, chatSessionId: null }

export const jobResult = {
  completed: (
    outcome: "finished" | "no_change" | "needs_you" | "blocked" | "superseded",
    result: string | null,
    run: JobRunRef
  ): AutomationJobResult => ({ status: "ended", outcome, result, error: null, ...run }),
  failed: (error: string | null, result: string | null, run: JobRunRef): AutomationJobResult => ({
    status: "ended",
    outcome: "failed",
    result,
    error,
    ...run
  }),
  withoutRun: (
    outcome: "no_input" | "no_change" | "superseded",
    result: string
  ): AutomationJobResult => ({
    status: "ended",
    outcome,
    result,
    error: null,
    ...NO_CHAT_RUN
  })
}

interface AutomationRunStart {
  readonly sessionId: string
  readonly clientId: string
  readonly prompt: string
  readonly name: string
  readonly handlerItem?: HandlerItemRef
}

export const startAutomationRun = (
  chat: Pick<ChatMessage["Service"], "startAutomation">,
  job: AutomationJobLease,
  run: AutomationRunStart
): Effect.Effect<ChatReceipt, ChatMessageFailure> =>
  chat.startAutomation({
    lease: { id: job.id, token: job.token },
    ...(run.handlerItem === undefined ? {} : { handlerItem: run.handlerItem }),
    sessionId: run.sessionId,
    clientId: run.clientId,
    prompt: run.prompt,
    automation: {
      automationId: job.payload.automationId,
      name: run.name,
      attemptId: job.payload.automationRunId
    },
    contextMode: job.payload.contextMode,
    ...automationModelSelection(job.payload)
  })
