import type { RecordedHistoryInput, RecordedHistoryPage } from "../history.js"
import { storeReasons } from "../errors.js"
import type {
  ResolveTaskProposalInput,
  ResolveTaskProposalResponse,
  TaskProposal,
  TaskProposalList,
  TaskProposalReview,
  TaskProposalScope,
  TaskProposalRetirementSource
} from "@arden-hq/protocol/proposals"
import type {
  CreateSpaceTaskInput,
  SpaceTaskCaptureInput,
  SpaceTaskSource
} from "@arden-hq/protocol/spaces/work"
import { Context, Effect, Schema } from "effect"
import type { TaskProposalConflictError } from "./conflict.js"

export interface ProposeSpaceTaskInput {
  readonly spaceId: string | undefined
  readonly runId: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly input: CreateSpaceTaskInput
  readonly capture: SpaceTaskCaptureInput
  readonly sources: ReadonlyArray<SpaceTaskSource>
  readonly inferenceSnapshot: string
}

export interface RetireTaskProposalInput {
  readonly spaceId: string
  readonly runId: string
  readonly toolCallId: string
  readonly proposalId: string
  readonly expectedRevision: number
  readonly snapshot: string
  readonly reason: string
  readonly sources: ReadonlyArray<TaskProposalRetirementSource>
}

export interface TaskProposalSettlementAuthority {
  readonly memory: ReadonlyArray<{
    readonly page_ref: string
    readonly revision: string
  }>
}

export class TaskProposalStoreError extends Schema.TaggedError<TaskProposalStoreError>()(
  "TaskProposalStoreError",
  {
    reason: storeReasons(["invalid", "not_found", "conflict", "storage"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

type Result<A> = Effect.Effect<A, TaskProposalStoreError>
export type ProposalResult<A> = Effect.Effect<A, TaskProposalStoreError | TaskProposalConflictError>

export interface ReviseTaskProposalInput {
  readonly spaceId: string
  readonly proposalId: string
  readonly expectedRevision: number
  readonly runId: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly input: Omit<CreateSpaceTaskInput, "key">
  readonly capture: SpaceTaskCaptureInput
  readonly sources: ReadonlyArray<SpaceTaskSource>
  readonly inferenceSnapshot: string
}

export class TaskProposalStore extends Context.Service<
  TaskProposalStore,
  {
    readonly history: (input: RecordedHistoryInput) => Result<RecordedHistoryPage>
    readonly list: (scope: TaskProposalScope) => Result<TaskProposalList>
    readonly get: (proposalId: string) => Result<TaskProposal | undefined>
    readonly retire: (input: RetireTaskProposalInput) => Result<TaskProposal>
    readonly propose: (input: ProposeSpaceTaskInput) => Result<TaskProposal>
    readonly revise: (input: ReviseTaskProposalInput) => ProposalResult<TaskProposal>
    readonly requestProposalReview: (input: {
      readonly proposalId: string
      readonly expectedRevision: number
    }) => ProposalResult<TaskProposalReview>
    readonly proposalReviewStatus: (input: {
      readonly proposalId: string
    }) => Result<TaskProposalReview | undefined>
    readonly suggestFromItem: (input: {
      readonly itemId: string
      readonly text: string
      readonly why: string
    }) => Result<TaskProposal | undefined>
    readonly resolve: (
      proposalId: string,
      input: ResolveTaskProposalInput,
      authority: TaskProposalSettlementAuthority
    ) => ProposalResult<ResolveTaskProposalResponse>
  }
>()("@arden-hq/server/persistence/proposals/TaskProposalStore") {}
