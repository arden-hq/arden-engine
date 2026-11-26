import type { JobDriver } from "@arden-hq/jobs"
import type { ChatRunErrorCode } from "@arden-hq/protocol/chat"
import { Context, type Effect, Schema } from "effect"
import type {
  AutomationEventScreen,
  AutomationEventScreenOutcome,
  AutomationJobLeaseRef,
  AutomationJobSettlement,
  AutomationStoreError,
  ClaimedAutomationJobPayload
} from "./store.js"
import type { AutomationId } from "./model.js"
import type { RunEvents } from "./event-batch.js"

const AUTOMATION_BLOCKED_KIND = {
  transient: "transient",
  needs_input: "needs_input",
  capability: "capability",
  dependency: "dependency"
} as const
type AutomationBlockedKind = (typeof AUTOMATION_BLOCKED_KIND)[keyof typeof AUTOMATION_BLOCKED_KIND]
export const AutomationBlockedKindSchema = Schema.Literals(Object.values(AUTOMATION_BLOCKED_KIND))
export const isAutomationBlockedKind = Schema.is(AutomationBlockedKindSchema)

export const HANDLER_TOOL_NAMES = ["publish_home_letter", "post_message"] as const
export type HandlerToolName = (typeof HANDLER_TOOL_NAMES)[number]

export interface AutomationBlockedReport {
  readonly kind: AutomationBlockedKind
  readonly reason: string
}

export const AUTOMATION_FOLLOWUP = { stop: "stop", check_again: "check_again" } as const

export type AutomationFollowup =
  | { readonly action: typeof AUTOMATION_FOLLOWUP.stop }
  | { readonly action: typeof AUTOMATION_FOLLOWUP.check_again; readonly at: string }

export interface FollowupOwner {
  readonly task_id: string
  readonly automation_ref: string
  readonly name: string
}

export interface ForkSession {
  readonly sessionId: string
  readonly sourceSessionId: string
}

export const OBSERVED_RUN = {
  running: "running",
  paused: "paused",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled"
} as const

export interface TerminalAutomationChatRun {
  readonly status:
    | typeof OBSERVED_RUN.completed
    | typeof OBSERVED_RUN.failed
    | typeof OBSERVED_RUN.cancelled
  readonly result: string | null
  readonly error: string | null
  readonly errorCode: ChatRunErrorCode | null
  readonly blocked: AutomationBlockedReport | null
  readonly noChange: string | null
  readonly wrote: boolean
}

interface PausedAutomationChatRun {
  readonly status: typeof OBSERVED_RUN.paused
  readonly sessionId: string
  readonly until: string
}

export type ObservedAutomationChatRun =
  | { readonly status: typeof OBSERVED_RUN.running }
  | PausedAutomationChatRun
  | TerminalAutomationChatRun

interface SettledAutomationOccurrence extends TerminalAutomationChatRun {
  readonly runId: string
  readonly sessionId: string
}

export type ObservedAutomationOccurrence =
  | { readonly status: typeof OBSERVED_RUN.running }
  | PausedAutomationChatRun
  | SettledAutomationOccurrence

export class AutomationQueue extends Context.Service<
  AutomationQueue,
  {
    readonly requestRun: (
      automationId: AutomationId
    ) => Effect.Effect<boolean, AutomationStoreError>
    readonly requestRunWithEvent: (
      automationId: AutomationId,
      skippedRunId: number
    ) => Effect.Effect<boolean, AutomationStoreError>
    readonly prepareRunSession: (
      lease: AutomationJobLeaseRef
    ) => Effect.Effect<string, AutomationStoreError>
    readonly prepareForkSession: (
      lease: AutomationJobLeaseRef
    ) => Effect.Effect<ForkSession | null, AutomationStoreError>
    readonly prepareOwnChat: (
      lease: AutomationJobLeaseRef
    ) => Effect.Effect<string, AutomationStoreError>
    readonly observeChatRun: (
      chatRunId: string
    ) => Effect.Effect<ObservedAutomationChatRun | null, AutomationStoreError>
    readonly handlerToolResult: (input: {
      readonly runId: string
      readonly tool: HandlerToolName
    }) => Effect.Effect<string | undefined, AutomationStoreError>
    readonly observeOccurrence: (
      attemptId: number
    ) => Effect.Effect<ObservedAutomationOccurrence | null, AutomationStoreError>
    readonly reportBlocked: (input: {
      readonly sessionId: string
      readonly chatRunId: string
      readonly report: AutomationBlockedReport
    }) => Effect.Effect<void, AutomationStoreError>
    readonly setFollowup: (input: {
      readonly sessionId: string
      readonly chatRunId: string
      readonly followup: AutomationFollowup
    }) => Effect.Effect<FollowupOwner, AutomationStoreError>
    readonly runEvents: (input: {
      readonly sessionId: string
      readonly chatRunId: string
    }) => Effect.Effect<RunEvents | undefined, AutomationStoreError>
    readonly recordEventScreen: (input: {
      readonly lease: AutomationJobLeaseRef
      readonly screen: AutomationEventScreen
      readonly now: number
    }) => Effect.Effect<AutomationEventScreenOutcome, AutomationStoreError>
    readonly jobs: JobDriver<ClaimedAutomationJobPayload, AutomationJobSettlement>
  }
>()("@arden-hq/server/persistence/automations/AutomationQueue") {}
