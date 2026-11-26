import { AUTOMATION_RUN_OUTCOME } from "@arden-hq/protocol/automations"
import type { ChatSendReceipt } from "../persistence/chat/send-contracts.js"
import { Effect } from "effect"
import type { ChatMessage } from "../chat/message.js"
import {
  CHAT_MESSAGE_FAILURE,
  ChatMessageError,
  type ChatMessageFailure
} from "../chat/message-errors.js"
import type { HandlerItemRef } from "../persistence/automations/handler-item.js"
import {
  AUTOMATION_JOB_STATUS,
  type AutomationJobLease,
  type AutomationJobResult
} from "../persistence/automations/store.js"
import {
  AUTOMATION_BLOCKED_KIND,
  OBSERVED_RUN,
  type AutomationBlockedReport,
  type TerminalAutomationChatRun
} from "../persistence/automations/queue.js"
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
    | { readonly status: typeof OBSERVED_RUN.running }
    | {
        readonly status: typeof OBSERVED_RUN.paused
        readonly sessionId: string
        readonly until: string
      }
    | Ended
    | null,
    E
  >
): Effect.fn.Return<Ended, E | PlanLimitPause> {
  while (true) {
    const observed = yield* observe
    if (observed === null) throw new Error("Automation Chat run disappeared")
    if (observed.status === OBSERVED_RUN.paused)
      return yield* Effect.fail(new PlanLimitPause(observed.sessionId, Date.parse(observed.until)))
    if (observed.status !== OBSERVED_RUN.running) return observed
    yield* Effect.sleep("250 millis")
  }
})

export const isNoModelProvider = (cause: unknown): cause is ChatMessageError =>
  cause instanceof ChatMessageError && cause.reason === CHAT_MESSAGE_FAILURE.unavailable

export type AwaitAutomationRun = (runId: string) => Effect.Effect<TerminalAutomationChatRun, Error>

interface JobRunRef {
  readonly chatRunId: string | null
  readonly chatSessionId: string | null
}

export const NO_CHAT_RUN: JobRunRef = { chatRunId: null, chatSessionId: null }

export const blockedOutcome = (blocked: AutomationBlockedReport): "needs_you" | "blocked" =>
  blocked.kind === AUTOMATION_BLOCKED_KIND.needs_input
    ? AUTOMATION_RUN_OUTCOME.needs_you
    : AUTOMATION_RUN_OUTCOME.blocked

export const jobResult = {
  completed: (
    outcome: "finished" | "no_change" | "needs_you" | "blocked" | "superseded",
    result: string | null,
    run: JobRunRef
  ): AutomationJobResult => ({
    status: AUTOMATION_JOB_STATUS.ended,
    outcome,
    result,
    error: null,
    ...run
  }),
  failed: (error: string | null, result: string | null, run: JobRunRef): AutomationJobResult => ({
    status: AUTOMATION_JOB_STATUS.ended,
    outcome: AUTOMATION_RUN_OUTCOME.failed,
    result,
    error,
    ...run
  }),
  blocked: (
    blocked: AutomationBlockedReport,
    result: string | null,
    run: JobRunRef
  ): AutomationJobResult => ({
    status: AUTOMATION_JOB_STATUS.ended,
    outcome: blockedOutcome(blocked),
    result,
    error: blocked.reason,
    ...run
  }),
  withoutRun: (
    outcome: "no_input" | "no_change" | "superseded",
    result: string
  ): AutomationJobResult => ({
    status: AUTOMATION_JOB_STATUS.ended,
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
): Effect.Effect<ChatSendReceipt, ChatMessageFailure> =>
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
