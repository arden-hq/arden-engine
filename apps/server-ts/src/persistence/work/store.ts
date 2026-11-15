import type { RecordedHistoryInput, RecordedHistoryPage } from "../history.js"
import type { TaskWorkerSnapshot } from "../automations/job-prompt.js"
import type { PermissionOfferRecord } from "../permissions/offer.js"
import type { ContractProposalRecord, CriterionMet, EvidenceInput } from "./contract.js"
import { storeReasons } from "../errors.js"
import type {
  CreateChatTaskInput,
  CreateSpaceTaskInput,
  CreateSpaceTaskCommentInput,
  SpaceWorkPage,
  SpaceWorkPageOptions,
  SpaceTask,
  SpaceTaskCaptureInput,
  SpaceTaskAttachment,
  SpaceTaskComment,
  NewTaskInput,
  UpdateSpaceTaskPatch
} from "@arden-hq/protocol/spaces/work"
import type { CreateSpaceTaskAttachmentRequest } from "@arden-hq/protocol/effect/spaces/work"
import type { RunDelivery } from "../deliveries/model.js"
import type { WorkerAttemptPage, WorkerAttemptPageOptions } from "@arden-hq/protocol/runs"
import type {
  ResolveRunQuestionInput,
  RunQuestion,
  RunQuestionContent,
  RunQuestionList,
  RunQuestionListOptions
} from "@arden-hq/protocol/runs"
import { Context, Effect, Schema } from "effect"
import type { TaskInferenceReview } from "./inference.js"
import type { AutomationId } from "../automations/model.js"
import type { TodoListItem } from "@arden-hq/protocol"
import type { FinishRecord, OriginalRequest } from "../todos/items.js"

export interface TaskIntent {
  readonly asked: string
  readonly now: string
}

export type TaskFinishCheck =
  | {
      readonly kind: "warn"
      readonly open: ReadonlyArray<TodoListItem>
      readonly request: OriginalRequest | undefined
      readonly record: FinishRecord
    }
  | { readonly kind: "close"; readonly record: FinishRecord }

export interface WorkAttachmentContent {
  readonly metadata: SpaceTaskAttachment
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

export type TaskScope =
  | { readonly kind: "space"; readonly spaceId: string }
  | { readonly kind: "chat"; readonly sessionId: string }
  | { readonly kind: "none" }

export type CreateTaskInput = NewTaskInput & { readonly key?: string }

export type TaskAddress =
  | { readonly kind: "key"; readonly scope: TaskScope; readonly key: string }
  | { readonly kind: "item"; readonly itemId: string }

export type FocusQuestionTargetInput =
  | { readonly kind: "existing"; readonly session_ref: string }
  | {
      readonly kind: "create"
      readonly name: string
      readonly purpose?: string
      readonly starts_with?: ReadonlyArray<string>
    }

export class WorkStoreError extends Schema.TaggedError<WorkStoreError>()("WorkStoreError", {
  reason: storeReasons(["invalid", "not_found", "conflict", "storage"]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export const TELL_LIMIT = 5

export const TELL_TEXT_LIMIT = 500

export type TellOutcome =
  | { readonly kind: "told"; readonly n: number; readonly left: number; readonly chatId: string }
  | { readonly kind: "again"; readonly n: number; readonly chatId: string | undefined }
  | { readonly kind: "refused"; readonly reason: string }

export type TaskExecutionReceipt =
  | { readonly kind: "saved" }
  | { readonly kind: "queued" }
  | { readonly kind: "working" }
  | { readonly kind: "scheduled"; readonly at: string }
  | { readonly kind: "inactive"; readonly state: SpaceTask["status"] | SpaceTask["activity"] }

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
    readonly acknowledgeDelivery: (
      deliveryId: string,
      runId: string
    ) => Effect.Effect<void, WorkStoreError>
    readonly discardStoppedResults: (
      runIds: ReadonlyArray<string>
    ) => Effect.Effect<void, WorkStoreError>
    readonly deferDelivery: (
      deliveryId: string,
      cause: string
    ) => Effect.Effect<void, WorkStoreError>
    readonly questions: (
      options: RunQuestionListOptions
    ) => Effect.Effect<RunQuestionList, WorkStoreError>
    readonly expireQuestions: () => Effect.Effect<void, WorkStoreError>
    readonly askQuestion: (options: {
      readonly runId: string
      readonly toolCallId: string
      readonly content: RunQuestionContent
      readonly reuseOpenTaskQuestion?: true
      readonly timeout?: { readonly seconds: number; readonly fallbackChoiceId: string }
      readonly focusTarget?: FocusQuestionTargetInput
      readonly permissionOffer?: PermissionOfferRecord
      readonly contractProposal?: ContractProposalRecord
    }) => Effect.Effect<RunQuestion, WorkStoreError>
    readonly meetCriterion: (input: {
      readonly itemId: string
      readonly lineId: number
      readonly evidence: EvidenceInput
    }) => Effect.Effect<CriterionMet, WorkStoreError>
    readonly resolveQuestion: (options: {
      readonly questionId: string
      readonly input: ResolveRunQuestionInput
    }) => Effect.Effect<RunQuestion, WorkStoreError>
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
    readonly page: (options: SpaceWorkPageOptions) => Effect.Effect<SpaceWorkPage, WorkStoreError>
    readonly create: (
      scope: TaskScope,
      input: CreateTaskInput
    ) => Effect.Effect<SpaceTask, WorkStoreError>
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
      input: CreateChatTaskInput
    ) => Effect.Effect<SpaceTask, WorkStoreError>
    readonly createFromChat: (options: {
      readonly scope: TaskScope
      readonly input: CreateSpaceTaskInput
      readonly sessionId: string
      readonly runId: string
      readonly toolCallId?: string
      readonly capture: SpaceTaskCaptureInput
    }) => Effect.Effect<SpaceTask, WorkStoreError>
    readonly get: (address: TaskAddress) => Effect.Effect<SpaceTask, WorkStoreError>
    readonly getFromJob: (
      originAutomationId: string,
      key: string,
      requestedSpaceId?: string
    ) => Effect.Effect<SpaceTask, WorkStoreError>
    readonly update: (
      address: TaskAddress,
      expectedUpdatedAt: string,
      patch: UpdateSpaceTaskPatch,
      runId?: string,
      toolCallId?: string,
      actor?: "user"
    ) => Effect.Effect<SpaceTask, WorkStoreError>
    readonly stop: (
      address: TaskAddress,
      expectedUpdatedAt: string
    ) => Effect.Effect<SpaceTask, WorkStoreError>
    readonly comment: (
      address: TaskAddress,
      input: CreateSpaceTaskCommentInput,
      runId?: string
    ) => Effect.Effect<SpaceTaskComment, WorkStoreError>
    readonly finishCheck: (options: {
      readonly runId: string
      readonly itemId: string
    }) => Effect.Effect<TaskFinishCheck, WorkStoreError>
    readonly updateFromJob: (
      originAutomationId: AutomationId,
      key: string,
      expectedUpdatedAt: string,
      patch: UpdateSpaceTaskPatch,
      spaceId?: string,
      runId?: string,
      toolCallId?: string
    ) => Effect.Effect<SpaceTask, WorkStoreError>
    readonly commentFromJob: (
      originAutomationId: AutomationId,
      key: string,
      input: CreateSpaceTaskCommentInput,
      spaceId?: string,
      runId?: string
    ) => Effect.Effect<SpaceTaskComment, WorkStoreError>
    readonly createAttachment: (
      address: TaskAddress,
      input: CreateSpaceTaskAttachmentRequest,
      runId?: string
    ) => Effect.Effect<SpaceTaskAttachment, WorkStoreError>
    readonly attachment: (
      attachmentId: number
    ) => Effect.Effect<WorkAttachmentContent | null, WorkStoreError>
  }
>()("@arden-hq/server/persistence/work/WorkStore") {}
