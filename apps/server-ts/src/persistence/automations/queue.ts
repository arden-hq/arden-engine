import type { JobDriver } from "@arden-hq/jobs"
import type { ChatRunErrorCode } from "@arden-hq/protocol/chat"
import { Context, type Effect } from "effect"
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

export const AUTOMATION_BLOCKED_KINDS = [
  "transient",
  "needs_input",
  "capability",
  "dependency"
] as const
type AutomationBlockedKind = (typeof AUTOMATION_BLOCKED_KINDS)[number]

export interface AutomationBlockedReport {
  readonly kind: AutomationBlockedKind
  readonly reason: string
}

export type AutomationFollowup =
  | { readonly action: "stop" }
  | { readonly action: "check_again"; readonly at: string }

export interface FollowupOwner {
  readonly task_id: string
  readonly automation_ref: string
  readonly name: string
}

export interface ForkSession {
  readonly sessionId: string
  readonly sourceSessionId: string
}

export interface TerminalAutomationChatRun {
  readonly status: "completed" | "failed" | "cancelled"
  readonly result: string | null
  readonly error: string | null
  readonly errorCode: ChatRunErrorCode | null
  readonly blocked: AutomationBlockedReport | null
  readonly wrote: boolean
}

interface PausedAutomationChatRun {
  readonly status: "paused"
  readonly sessionId: string
  readonly until: string
}

export type ObservedAutomationChatRun =
  | { readonly status: "running" }
  | PausedAutomationChatRun
  | TerminalAutomationChatRun

interface SettledAutomationOccurrence extends TerminalAutomationChatRun {
  readonly runId: string
  readonly sessionId: string
}

export type ObservedAutomationOccurrence =
  | { readonly status: "running" }
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
