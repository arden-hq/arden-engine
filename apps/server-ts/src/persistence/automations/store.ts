import { storeErrorFields } from "../errors.js"
import type { SpaceReviewInput } from "./space-review.js"
import type { JobPurpose } from "../job-classification.js"
import type { HomeLetterInput } from "../home/model.js"
import type { HandlerItem } from "./handler-item.js"
import type { AutomationJobPrompt } from "./job-prompt.js"
import type {
  AutomationContextMode,
  AutomationRunOutcome,
  AutomationRunSkip,
  AutomationSkippedEvent
} from "@arden-hq/protocol/automations"
import type { JobLease } from "@arden-hq/jobs"
import { Schema } from "effect"
import type { SystemHandlerId } from "./model.js"
import type { AutomationId } from "./model.js"

const AUTOMATION_QUEUE_SOURCES = ["scheduled", "manual", "event", "idle", "count", "wake"] as const
export type AutomationQueueSource = (typeof AUTOMATION_QUEUE_SOURCES)[number]

interface AutomationJobPayloadFields<Prompt> {
  readonly purpose: JobPurpose
  readonly automationId: AutomationId
  readonly name: string
  readonly automationRunId: number
  readonly sessionId: string | null
  readonly prompt: Prompt
  readonly model: string | null
  readonly chatKind: "own" | "yours"
  readonly contextMode: AutomationContextMode
  readonly chatRun: {
    readonly runId: string
    readonly sessionId: string
    readonly authority: "active" | "settling" | "revoked"
  } | null
  readonly occurrence: AutomationQueueSource
  readonly scheduledFor?: string
  readonly triggeringChange: string | null
  readonly prefilter: AutomationJobPrefilter | null
  readonly proposalReviewTarget?: {
    readonly proposalId: string
    readonly expectedRevision: number
  }
}

interface AutomationJobPrefilter {
  readonly events: readonly [AutomationJobPrefilterEvent, ...Array<AutomationJobPrefilterEvent>]
}

export type AutomationJobPrefilterEvent =
  | { readonly key: string; readonly sentences: null }
  | {
      readonly key: string
      readonly sentences: readonly [string, ...Array<string>]
      readonly prompt: string
      readonly event: AutomationSkippedEvent
    }

export interface AutomationEventScreen {
  readonly skipped: readonly [ScreenedSkip, ...Array<ScreenedSkip>]
  readonly passed: ReadonlyArray<string>
}

interface ScreenedSkip {
  readonly key: string
  readonly skip: StoredAutomationRunSkip
}

export type AutomationEventScreenOutcome =
  | { readonly kind: "skip"; readonly skip: StoredAutomationRunSkip }
  | { readonly kind: "run"; readonly triggerContext: string }

interface StoredPrefilterSkip extends AutomationRunSkip {
  readonly prompt: string
}

export interface SpaceReviewGateSkip {
  readonly reason: "space_review_gate"
  readonly backend: string
  readonly nothing: number
}

export type StoredAutomationRunSkip = StoredPrefilterSkip | SpaceReviewGateSkip

export type HandlerItemOwnerId = Extract<
  SystemHandlerId,
  "memory_capture" | "daily_summary" | "wiki_maintenance"
>

export type AutomationJobHandler =
  | { readonly handler: null; readonly spaceReviewInput?: SpaceReviewInput }
  | { readonly handler: "home_letter"; readonly homeLetterInput?: HomeLetterInput }
  | { readonly handler: HandlerItemOwnerId; readonly handlerItem?: HandlerItem }
  | { readonly handler: "managed_history_collection" | "chat_summaries" }

export type AutomationJobPayload = AutomationJobPayloadFields<string> & AutomationJobHandler

export const jobHandlerItem = (payload: AutomationJobHandler): HandlerItem | undefined =>
  "handlerItem" in payload ? payload.handlerItem : undefined

export type AutomationJobOutcome =
  | Exclude<AutomationRunOutcome, "interrupted" | "skipped:prefilter" | "skipped:space_review_gate">
  | "no_input"

export interface AutomationJobResult {
  readonly status: "ended"
  readonly outcome: AutomationJobOutcome
  readonly result: string | null
  readonly error: string | null
  readonly chatRunId: string | null
  readonly chatSessionId: string | null
}

export interface AutomationJobDeferral {
  readonly status: "deferred"
  readonly cause: "session_busy" | "no_model" | "plan_limit"
  readonly reason: string
  readonly retryAt: number
  readonly sessionId: string | null
}

export interface AutomationJobSkip {
  readonly status: "skipped"
  readonly skip: StoredAutomationRunSkip
}

export type AutomationJobSettlement =
  | AutomationJobResult
  | AutomationJobDeferral
  | AutomationJobSkip

export type AutomationJobLease = JobLease<AutomationJobPayload>

export type ClaimedAutomationJobPayload = AutomationJobPayloadFields<AutomationJobPrompt> &
  AutomationJobHandler
export type ClaimedAutomationJobLease = JobLease<ClaimedAutomationJobPayload>
export type AutomationJobLeaseRef = JobLease<Omit<AutomationJobPayload, "prompt">>

export class AutomationStoreError extends Schema.TaggedError<AutomationStoreError>()(
  "AutomationStoreError",
  {
    ...storeErrorFields({
      operations: [
        "diagnostics",
        "list",
        "get",
        "create",
        "update",
        "toggle",
        "delete",
        "runs",
        "request_run",
        "claim",
        "renew",
        "complete",
        "defer",
        "fail",
        "release",
        "recover",
        "prepare_run_session",
        "prepare_home_letter",
        "space_review",
        "handler_item",
        "observe_chat_run",
        "seed_builtin",
        "reconcile_space_jobs",
        "trigger_feed",
        "dispatch_event",
        "event_triggers",
        "rearm_idle",
        "record_skips"
      ],
      reasons: ["invalid", "not_found", "conflict", "corrupt", "storage"]
    }),
    automationId: Schema.optionalKey(Schema.NonEmptyString)
  }
) {}
