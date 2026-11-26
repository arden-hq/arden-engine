import {
  type StoredResolveInput,
  type StoredRunQuestion,
  type StoredRunQuestionContent,
  type StoredRunQuestionList
} from "../runs/stored-question.js"
import {
  type TaskAttachmentRecord,
  type TaskCommentRecord,
  type TaskRecord,
  type WorkPageRecord
} from "./task-record.js"
import { type TaskPatch } from "./task-patch.js"
import { type ChatTaskDraft, type KeyedTaskDraft, type TaskDraft } from "./task-input.js"
import {
  WORK_PAGE_DEFAULT_LIMIT,
  WORK_PAGE_SCOPE,
  WORK_PAGE_START
} from "@arden-hq/protocol/spaces/work"
import type { RecordedHistoryInput, RecordedHistoryPage } from "../history.js"
import type { TaskWorkerSnapshot } from "../automations/job-prompt.js"
import type { PermissionOfferRecord } from "../permissions/offer.js"
import type { ContractProposalRecord, CriterionMet, EvidenceInput } from "./contract.js"
import { storeReasons } from "../errors.js"
import type {
  CreateSpaceTaskCommentInput,
  SpaceWorkPageOptions,
  SpaceTaskCaptureInput
} from "@arden-hq/protocol/spaces/work"
import type { CreateSpaceTaskAttachmentRequest } from "@arden-hq/protocol/effect/spaces/work"
import type { RunDelivery } from "../deliveries/model.js"
import type { WorkerAttemptPage, WorkerAttemptPageOptions } from "@arden-hq/protocol/runs"
import type { RunQuestionListOptions } from "@arden-hq/protocol/runs"
import { Context, Effect, Schema } from "effect"
import type { TaskInferenceReview } from "./inference.js"
import type { TaskDirectionChanged } from "./task-direction.js"
import type { AutomationId } from "../automations/model.js"
import type { TodoListItem } from "@arden-hq/protocol"
import type { FinishRecord, OriginalRequest } from "../todos/items.js"

export interface TaskIntent {
  readonly asked: string
  readonly now: string
}

const TASK_FINISH_CHECK = { warn: "warn", close: "close" } as const

export type TaskFinishCheck =
  | {
      readonly kind: typeof TASK_FINISH_CHECK.warn
      readonly open: ReadonlyArray<TodoListItem>
      readonly request: OriginalRequest | undefined
      readonly record: FinishRecord
    }
  | { readonly kind: typeof TASK_FINISH_CHECK.close; readonly record: FinishRecord }

export interface WorkAttachmentContent {
  readonly metadata: TaskAttachmentRecord
  readonly data: Uint8Array
}

export const taskFileHref = (itemId: string, attachmentId: number): string =>
  `arden:task/${encodeURIComponent(itemId)}/file/${attachmentId}`

export interface ChatTaskContext {
  readonly key: string
  readonly task: TaskWorkerSnapshot
}

export interface InChatStep {
  readonly itemId: string
  readonly sessionId: string
  readonly text: string
  readonly approvalMode: string | null
}

export type SpentScope =
  | { readonly runId: string }
  | { readonly sessionId: string }
  | { readonly itemId: string }

export const TASK_SCOPE = { space: "space", chat: "chat", none: "none" } as const

export type TaskScope =
  | { readonly kind: typeof TASK_SCOPE.space; readonly spaceId: string }
  | { readonly kind: typeof TASK_SCOPE.chat; readonly sessionId: string }
  | { readonly kind: typeof TASK_SCOPE.none }

export type CreateTaskInput = TaskDraft & { readonly key?: string }

const TASK_ADDRESS = { key: "key", item: "item" } as const

export type TaskAddress =
  | { readonly kind: typeof TASK_ADDRESS.key; readonly scope: TaskScope; readonly key: string }
  | { readonly kind: typeof TASK_ADDRESS.item; readonly itemId: string }

export type FocusQuestionTargetInput =
  | { readonly kind: "existing"; readonly session_ref: string }
  | {
      readonly kind: "create"
      readonly name: string
      readonly purpose?: string
      readonly starts_with?: ReadonlyArray<string>
    }

export const itemPage = (itemId: string): SpaceWorkPageOptions => ({
  scope: { kind: WORK_PAGE_SCOPE.item, item_id: itemId },
  start: { kind: WORK_PAGE_START.first },
  limit: WORK_PAGE_DEFAULT_LIMIT
})

export const pageWithItem = (itemId: string): SpaceWorkPageOptions => ({
  scope: { kind: WORK_PAGE_SCOPE.all },
  start: { kind: WORK_PAGE_START.with_item, item_id: itemId },
  limit: 1
})

export class WorkStoreError extends Schema.TaggedError<WorkStoreError>()("WorkStoreError", {
  reason: storeReasons(["invalid", "not_found", "conflict", "storage"]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export const TELL_LIMIT = 5

export const TELL_TEXT_LIMIT = 500

const TELL_OUTCOME = { told: "told", again: "again", refused: "refused" } as const

export type TellOutcome =
  | {
      readonly kind: typeof TELL_OUTCOME.told
      readonly n: number
      readonly left: number
      readonly chatId: string
    }
  | {
      readonly kind: typeof TELL_OUTCOME.again
      readonly n: number
      readonly chatId: string | undefined
    }
  | { readonly kind: typeof TELL_OUTCOME.refused; readonly reason: string }

export const TASK_EXECUTION_RECEIPT = {
  saved: "saved",
  queued: "queued",
  working: "working",
  scheduled: "scheduled",
  inactive: "inactive"
} as const

export type TaskExecutionReceipt =
  | { readonly kind: typeof TASK_EXECUTION_RECEIPT.saved }
  | { readonly kind: typeof TASK_EXECUTION_RECEIPT.queued }
  | { readonly kind: typeof TASK_EXECUTION_RECEIPT.working }
  | { readonly kind: typeof TASK_EXECUTION_RECEIPT.scheduled; readonly at: string }
  | {
      readonly kind: typeof TASK_EXECUTION_RECEIPT.inactive
      readonly state: TaskRecord["status"] | TaskRecord["activity"]
    }

export class WorkStore extends Context.Service<
  WorkStore,
  {
    readonly history: (
      input: RecordedHistoryInput
    ) => Effect.Effect<RecordedHistoryPage, WorkStoreError>
    readonly reportNoChange: (
      runId: string,
      reason: string
    ) => Effect.Effect<{ readonly quiet: boolean }, WorkStoreError>
    readonly tell: (input: {
      readonly runId: string
      readonly toolCallId: string
      readonly text: string
    }) => Effect.Effect<TellOutcome, WorkStoreError>
    readonly attempts: (
      itemId: string,
      options: WorkerAttemptPageOptions
    ) => Effect.Effect<WorkerAttemptPage, WorkStoreError>
    readonly revokedRuns: () => Effect.Effect<
      ReadonlyArray<{ readonly runId: string; readonly sessionId: string }>,
      WorkStoreError
    >
    readonly pendingDeliveries: () => Effect.Effect<ReadonlyArray<RunDelivery>, WorkStoreError>
    readonly discardStoppedResults: (
      runIds: ReadonlyArray<string>
    ) => Effect.Effect<void, WorkStoreError>
    readonly deferDelivery: (
      deliveryId: string,
      cause: string
    ) => Effect.Effect<void, WorkStoreError>
    readonly questions: (
      options: RunQuestionListOptions
    ) => Effect.Effect<StoredRunQuestionList, WorkStoreError>
    readonly expireQuestions: () => Effect.Effect<void, WorkStoreError>
    readonly askQuestion: (options: {
      readonly runId: string
      readonly toolCallId: string
      readonly content: StoredRunQuestionContent
      readonly reuseOpenTaskQuestion?: true
      readonly timeout?: { readonly seconds: number; readonly fallbackChoiceId: string }
      readonly focusTarget?: FocusQuestionTargetInput
      readonly permissionOffer?: PermissionOfferRecord
      readonly contractProposal?: ContractProposalRecord
    }) => Effect.Effect<StoredRunQuestion, WorkStoreError>
    readonly meetCriterion: (input: {
      readonly itemId: string
      readonly lineId: number
      readonly evidence: EvidenceInput
    }) => Effect.Effect<CriterionMet, WorkStoreError>
    readonly resolveQuestion: (options: {
      readonly questionId: string
      readonly input: StoredResolveInput
    }) => Effect.Effect<StoredRunQuestion, WorkStoreError>
    readonly moveToChat: (input: {
      readonly itemId: string
      readonly sessionId: string
    }) => Effect.Effect<void, WorkStoreError>
    readonly acknowledgeResult: (input: {
      readonly itemId: string
      readonly resultKey: string
    }) => Effect.Effect<void, WorkStoreError>
    readonly continuationContext: (
      runId: string
    ) => Effect.Effect<TaskWorkerSnapshot | undefined, WorkStoreError>
    readonly taskContext: (
      itemId: string
    ) => Effect.Effect<TaskWorkerSnapshot | undefined, WorkStoreError>
    readonly taskIntent: (itemId: string) => Effect.Effect<TaskIntent | undefined, WorkStoreError>
    readonly execution: (itemId: string) => Effect.Effect<TaskExecutionReceipt, WorkStoreError>
    readonly page: (options: SpaceWorkPageOptions) => Effect.Effect<WorkPageRecord, WorkStoreError>
    readonly create: (
      scope: TaskScope,
      input: CreateTaskInput
    ) => Effect.Effect<TaskRecord, WorkStoreError>
    readonly inferenceReview: (
      spaceId: string
    ) => Effect.Effect<TaskInferenceReview, WorkStoreError>
    readonly nextInChat: (
      scope: { readonly sessionId: string } | { readonly itemId: string }
    ) => Effect.Effect<InChatStep | undefined, WorkStoreError>
    readonly chatTask: (
      sessionId: string
    ) => Effect.Effect<ChatTaskContext | undefined, WorkStoreError>
    readonly runsInChat: (itemId: string) => Effect.Effect<boolean, WorkStoreError>
    readonly activeTaskRuns: (
      itemId: string
    ) => Effect.Effect<ReadonlyArray<string>, WorkStoreError>
    readonly idleInChat: () => Effect.Effect<ReadonlyArray<InChatStep>, WorkStoreError>
    readonly stopSpent: (scope: SpentScope) => Effect.Effect<void, WorkStoreError>
    readonly createInChat: (
      sessionId: string,
      input: ChatTaskDraft
    ) => Effect.Effect<TaskRecord, WorkStoreError>
    readonly createFromChat: (options: {
      readonly scope: TaskScope
      readonly input: KeyedTaskDraft
      readonly sessionId: string
      readonly runId: string
      readonly toolCallId?: string
      readonly capture: SpaceTaskCaptureInput
    }) => Effect.Effect<TaskRecord, WorkStoreError>
    readonly get: (address: TaskAddress) => Effect.Effect<TaskRecord, WorkStoreError>
    readonly getFromJob: (
      originAutomationId: string,
      key: string,
      requestedSpaceId?: string
    ) => Effect.Effect<TaskRecord, WorkStoreError>
    readonly update: (
      address: TaskAddress,
      expectedUpdatedAt: string,
      patch: TaskPatch,
      runId?: string,
      toolCallId?: string,
      actor?: "user"
    ) => Effect.Effect<TaskRecord, WorkStoreError | TaskDirectionChanged>
    readonly stop: (
      address: TaskAddress,
      expectedUpdatedAt: string
    ) => Effect.Effect<TaskRecord, WorkStoreError>
    readonly comment: (
      address: TaskAddress,
      input: CreateSpaceTaskCommentInput,
      runId?: string,
      toolCallId?: string
    ) => Effect.Effect<TaskCommentRecord, WorkStoreError | TaskDirectionChanged>
    readonly finishCheck: (options: {
      readonly runId: string
      readonly itemId: string
    }) => Effect.Effect<TaskFinishCheck, WorkStoreError>
    readonly updateFromJob: (
      originAutomationId: AutomationId,
      key: string,
      expectedUpdatedAt: string,
      patch: TaskPatch,
      spaceId?: string,
      runId?: string,
      toolCallId?: string
    ) => Effect.Effect<TaskRecord, WorkStoreError | TaskDirectionChanged>
    readonly commentFromJob: (
      originAutomationId: AutomationId,
      key: string,
      input: CreateSpaceTaskCommentInput,
      spaceId?: string,
      runId?: string,
      toolCallId?: string
    ) => Effect.Effect<TaskCommentRecord, WorkStoreError | TaskDirectionChanged>
    readonly createAttachment: (
      address: TaskAddress,
      input: CreateSpaceTaskAttachmentRequest,
      runId?: string
    ) => Effect.Effect<TaskAttachmentRecord, WorkStoreError>
    readonly attachment: (
      attachmentId: number
    ) => Effect.Effect<WorkAttachmentContent | null, WorkStoreError>
  }
>()("@arden-hq/server/persistence/work/WorkStore") {}
