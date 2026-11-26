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
  TaskProposalConflict,
  TaskProposalReview
} from "./contracts.js"

const identity = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1024))

const SignalSenderSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unnamed") }),
  Schema.Struct({ kind: Schema.Literal("named"), name: Schema.String })
]).pipe(Schema.toTaggedUnion("kind"))

const TaskProposalSignalSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unsignalled") }),
  Schema.Struct({
    kind: Schema.Literal("signal"),
    source: Schema.NonEmptyString,
    title: Schema.String,
    from: SignalSenderSchema
  })
]).pipe(Schema.toTaggedUnion("kind"))

const TaskProposalRetirementEvidenceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("chat"),
    session_id: identity,
    turn: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("whole_chat") }),
      Schema.Struct({ kind: Schema.Literal("turn"), turn_id: identity })
    ]),
    label: SignalSenderSchema
  }),
  Schema.Struct({ kind: Schema.Literal("memory"), page_ref: identity }),
  Schema.Struct({ kind: Schema.Literal("task"), item_id: identity, label: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("connection_item"),
    item_id: identity,
    label: Schema.String,
    link: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("unlinked") }),
      Schema.Struct({ kind: Schema.Literal("linked"), url: Schema.String })
    ])
  })
])

const TaskProposalRetirementSchema: Schema.Codec<TaskProposalRetirement> = withExtras({
  reason: Schema.String,
  evidence: Schema.Array(TaskProposalRetirementEvidenceSchema)
})

const taskProposalFields = {
  proposal_id: identity,
  placement: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("space"), space_id: identity }),
    Schema.Struct({ kind: Schema.Literal("chat"), session_id: identity })
  ]).pipe(Schema.toTaggedUnion("kind")),
  stable_key: WorkTaskKeySchema,
  text: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(WORK_TASK_TEXT_MAX_CHARS)),
  body: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("plain") }),
    Schema.Struct({
      kind: Schema.Literal("detailed"),
      text: Schema.String.check(Schema.isMaxLength(WORK_TASK_BODY_MAX_CHARS))
    })
  ]),
  owner: Schema.Literals(["worker", "user", "external"] as const),
  capture: SpaceTaskCaptureInputSchema,
  sources: Schema.Array(SpaceTaskSourceSchema),
  signal: TaskProposalSignalSchema,
  origin: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("router") }),
    Schema.Struct({
      kind: Schema.Literal("run"),
      run_id: identity,
      session_id: identity,
      turn_id: identity,
      tool_call_id: identity
    })
  ]),
  revision: NonNegativeIntSchema,
  created_at: IsoDateTimeStringSchema,
  updated_at: IsoDateTimeStringSchema
} as const

export const TaskProposalSchema: Schema.Codec<TaskProposal> = Schema.Union([
  withExtras({ ...taskProposalFields, status: Schema.Literal("held") }),
  withExtras({
    ...taskProposalFields,
    status: Schema.Literal("offered"),
    put_off: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("in_view") }),
      Schema.Struct({ kind: Schema.Literal("put_off"), until: IsoDateTimeStringSchema })
    ])
  }),
  withExtras({
    ...taskProposalFields,
    status: Schema.Literal("accepted"),
    settled_at: IsoDateTimeStringSchema,
    task: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("kept"), item_id: identity }),
      Schema.Struct({ kind: Schema.Literal("gone") })
    ])
  }),
  withExtras({
    ...taskProposalFields,
    status: Schema.Literals(["rejected", "expired"]),
    settled_at: IsoDateTimeStringSchema
  }),
  withExtras({
    ...taskProposalFields,
    status: Schema.Literal("retired"),
    settled_at: IsoDateTimeStringSchema,
    retirement: TaskProposalRetirementSchema
  })
])

export const TaskProposalListSchema: Schema.Codec<TaskProposalList> = withExtras({
  proposals: Schema.Array(TaskProposalSchema)
})

export const TaskProposalListQuerySchema = Schema.Union([
  Schema.Struct({ place: Schema.Literal("space"), space_id: identity }),
  Schema.Struct({ place: Schema.Literal("chat"), session_id: identity })
])

const resolveBase = {
  expected_revision: NonNegativeIntSchema,
  client_id: identity
} as const

export const ResolveTaskProposalInputSchema = Schema.Union([
  Schema.Struct({
    ...resolveBase,
    decision: Schema.Literal("accept"),
    space: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("proposed") }),
      Schema.Struct({ kind: Schema.Literal("chosen"), space_id: identity })
    ]),
    accepted_in: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("elsewhere") }),
      Schema.Struct({ kind: Schema.Literal("chat"), session_id: identity })
    ])
  }),
  Schema.Struct({ ...resolveBase, decision: Schema.Literal("reject") }),
  Schema.Struct({ ...resolveBase, decision: Schema.Literal("later") })
])

export const ResolveTaskProposalResponseSchema: Schema.Codec<ResolveTaskProposalResponse> =
  withExtras({
    proposal: TaskProposalSchema,
    task: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("started"), task: SpaceTaskSchema }),
      Schema.Struct({ kind: Schema.Literal("unstarted") })
    ])
  }).check(
    Schema.makeFilter((response) =>
      response.task.kind !== "started" || response.proposal.status === "accepted"
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

export const encodeResolveTaskProposalRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
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

export const TaskProposalReviewStatusSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("unrequested") }),
  TaskProposalReviewSchema
])

export const encodeRecheckTaskProposalRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
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
