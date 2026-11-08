import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, withExtras, NonNegativeIntSchema } from "../common/schema.js"
import type { Agrees, Assert } from "../common/type-agreement.js"
import {
  SpaceTaskCaptureInputSchema,
  SpaceTaskSchema,
  SpaceTaskSourceSchema,
  WorkTaskKeySchema
} from "../spaces/work/schema.js"
import { WORK_TASK_BODY_MAX_CHARS, WORK_TASK_TEXT_MAX_CHARS } from "../spaces/work/contracts.js"
import type {
  ResolveTaskProposalResponse,
  TaskProposal,
  TaskProposalList,
  TaskProposalRetirement,
  TaskProposalSignal,
  TaskProposalConflict,
  TaskProposalReview
} from "./contracts.js"

const identity = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1024))

export const TaskProposalPlaceSchema = Schema.Literals(["space", "chat", "home"] as const)

export const TaskProposalCapturePolicySchema = Schema.Struct({
  origin: Schema.Literals(["chat", "automation", "task", "space", "unrecorded"] as const),
  task_item_id: Schema.NullOr(identity),
  task_generation: Schema.NullOr(NonNegativeIntSchema)
})

export const TaskProposalSignalSchema: Schema.Codec<TaskProposalSignal> = withExtras({
  source: Schema.NonEmptyString,
  title: Schema.String,
  from: Schema.NullOr(Schema.String)
})

const TaskProposalRetirementEvidenceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("chat"),
    session_id: identity,
    turn_id: Schema.NullOr(identity),
    label: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({ kind: Schema.Literal("memory"), page_ref: identity }),
  Schema.Struct({ kind: Schema.Literal("task"), item_id: identity, label: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("connection_item"),
    item_id: identity,
    label: Schema.String,
    url: Schema.NullOr(Schema.String)
  })
])

const TaskProposalRetirementSchema: Schema.Codec<TaskProposalRetirement> = withExtras({
  reason: Schema.String,
  evidence: Schema.Array(TaskProposalRetirementEvidenceSchema)
})

export const TaskProposalSchema: Schema.Codec<TaskProposal> = withExtras({
  proposal_id: identity,
  place: TaskProposalPlaceSchema,
  space_id: Schema.NullOr(identity),
  chat_session_id: Schema.NullOr(identity),
  stable_key: WorkTaskKeySchema,
  text: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(WORK_TASK_TEXT_MAX_CHARS)),
  body: Schema.NullOr(Schema.String.check(Schema.isMaxLength(WORK_TASK_BODY_MAX_CHARS))),
  owner: Schema.Literals(["worker", "user", "external"] as const),
  capture: SpaceTaskCaptureInputSchema,
  sources: Schema.Array(SpaceTaskSourceSchema),
  signal: Schema.NullOr(TaskProposalSignalSchema),
  source_run_id: Schema.NullOr(identity),
  source_session_id: Schema.NullOr(identity),
  source_turn_id: Schema.NullOr(identity),
  source_tool_call_id: Schema.NullOr(identity),
  capture_policy: Schema.NullOr(TaskProposalCapturePolicySchema),
  revision: NonNegativeIntSchema,
  status: Schema.Literals(["held", "offered", "accepted", "rejected", "retired"] as const),
  retirement: Schema.NullOr(TaskProposalRetirementSchema),
  item_id: Schema.NullOr(identity),
  created_at: IsoDateTimeStringSchema,
  updated_at: IsoDateTimeStringSchema,
  settled_at: Schema.NullOr(IsoDateTimeStringSchema)
}).check(
  Schema.makeFilter((proposal) => {
    if ((proposal.place === "space") !== (proposal.space_id !== null))
      return "a proposal names a Space exactly when it waits on one"
    if ((proposal.place === "chat") !== (proposal.chat_session_id !== null))
      return "a proposal names a chat exactly when it waits in one"
    if ((proposal.status === "retired") !== (proposal.retirement !== null))
      return "a retirement is recorded exactly when a proposal is retired"
    if (proposal.status === "held" || proposal.status === "offered") {
      return proposal.item_id === null && proposal.settled_at === null
        ? undefined
        : "open proposals cannot have settlement fields"
    }
    if (
      (proposal.status === "rejected" || proposal.status === "retired") &&
      proposal.item_id !== null
    )
      return "a skipped proposal has no Task"
    return proposal.settled_at === null ? "settled proposals require settled_at" : undefined
  })
)

export const TaskProposalListSchema: Schema.Codec<TaskProposalList> = withExtras({
  proposals: Schema.Array(TaskProposalSchema)
})

/** `GET /proposals`: one Space's (`space_id`), one chat's (`session_id`), or Home's. */
export const TaskProposalListQuerySchema = Schema.Struct({
  place: TaskProposalPlaceSchema,
  space_id: Schema.optionalKey(identity),
  session_id: Schema.optionalKey(identity)
})

export const ResolveTaskProposalInputSchema = Schema.Struct({
  expected_revision: NonNegativeIntSchema,
  client_id: identity,
  decision: Schema.Literals(["accept", "reject"] as const),
  session_id: Schema.optionalKey(identity),
  space_id: Schema.optionalKey(identity)
})

export const ResolveTaskProposalResponseSchema: Schema.Codec<ResolveTaskProposalResponse> =
  withExtras({
    proposal: TaskProposalSchema,
    task: Schema.NullOr(SpaceTaskSchema)
  }).check(
    Schema.makeFilter((response) =>
      response.task === null || response.proposal.status === "accepted"
        ? undefined
        : "only a started proposal returns a Task"
    )
  )

/** @internal Compile-time check that the schema and the type agree. */
export type TaskProposalAgrees = Assert<Agrees<typeof TaskProposalSchema.Type, TaskProposal>>
/** @internal Compile-time check that the schema and the type agree. */
export type TaskProposalListAgrees = Assert<
  Agrees<typeof TaskProposalListSchema.Type, TaskProposalList>
>
/** @internal Compile-time check that the schema and the type agree. */
export type ResolveTaskProposalResponseAgrees = Assert<
  Agrees<typeof ResolveTaskProposalResponseSchema.Type, ResolveTaskProposalResponse>
>

export const encodeResolveTaskProposalRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(ResolveTaskProposalInputSchema)(value, {
    onExcessProperty: "error"
  }).pipe(Effect.map(JSON.stringify))

/** Exact action evidence is restricted to proposal retirement. */
export const ChatActionRetirementSourceSchema = Schema.Struct({
  kind: Schema.Literal("chat_action"),
  session_id: identity,
  turn_id: identity,
  run_id: identity,
  tool_call_id: identity,
  revision: identity
})

export const TaskProposalRetirementSourceSchema = Schema.Union([
  SpaceTaskSourceSchema,
  ChatActionRetirementSourceSchema
])

export const TaskProposalConflictKindSchema = Schema.Literals([
  "proposal_changed",
  "source_changed",
  "source_unavailable",
  "space_unavailable",
  "settled",
  "not_offered"
])

export const TaskProposalConflictSchema = Schema.Struct({
  kind: TaskProposalConflictKindSchema,
  message: Schema.String
})

export const RecheckTaskProposalInputSchema = Schema.Struct({
  expected_revision: NonNegativeIntSchema
})

export const TaskProposalReviewSchema = Schema.Struct({
  expected_revision: NonNegativeIntSchema,
  state: Schema.Literals(["queued", "running", "completed", "failed"]),
  message: Schema.String,
  proposal: TaskProposalSchema
})

export const TaskProposalReviewStatusSchema = Schema.NullOr(TaskProposalReviewSchema)

export const encodeRecheckTaskProposalRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(RecheckTaskProposalInputSchema)(value, {
    onExcessProperty: "error"
  }).pipe(Effect.map(JSON.stringify))

/** @internal */
export type TaskProposalConflictAgrees = Assert<
  Agrees<typeof TaskProposalConflictSchema.Type, TaskProposalConflict>
>
/** @internal */
export type TaskProposalReviewAgrees = Assert<
  Agrees<typeof TaskProposalReviewSchema.Type, TaskProposalReview>
>
