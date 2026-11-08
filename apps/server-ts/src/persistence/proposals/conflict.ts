import { TaskProposalConflictKindSchema } from "@arden-hq/protocol/effect/proposals"
import { Schema } from "effect"

export class TaskProposalConflictError extends Schema.TaggedError<TaskProposalConflictError>()(
  "TaskProposalConflictError",
  {
    kind: TaskProposalConflictKindSchema,
    message: Schema.String
  }
) {
  readonly reason = "conflict" as const
}
