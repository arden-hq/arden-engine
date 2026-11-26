import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, withExtras, NonNegativeIntSchema } from "../common/schema.js"
import { APPROVAL_MODES } from "../permissions/modes.js"
import { ChatRunningWorkSchema } from "../sessions/schema.js"
import { SpaceSnapshotSchema, SpaceTaskStatusSchema } from "./work/schema.js"
import { SPACE_AGENT, SPACE_KINDS, SPACE_MARK_COLOURS, SPACE_MARK_MEDIA } from "./contracts.js"
import type {
  SpaceConversationResponse,
  Space,
  SpaceListResponse,
  PinnedSpacesInput,
  SpacesOverview,
  SpaceDetail,
  SpaceArchiveResponse,
  SpaceEndConflict
} from "./contracts.js"

const strict = { onExcessProperty: "error" } as const
export const SpaceNameSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))
export const SpaceInstructionsTextSchema = Schema.String.check(Schema.isMaxLength(20_000))

export const SpaceApprovalModeSchema = Schema.Literals(APPROVAL_MODES)
export const TaskInferencePolicySchema = Schema.Struct({
  enabled: Schema.Boolean
})

const unit = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const SpaceMarkLookSchema = Schema.Struct({
  colour: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("automatic") }),
    Schema.Struct({ kind: Schema.Literal("chosen"), colour: Schema.Literals(SPACE_MARK_COLOURS) })
  ]).pipe(Schema.toTaggedUnion("kind")),
  medium: Schema.Literals(SPACE_MARK_MEDIA),
  zoom: unit,
  aberration: unit,
  focus: unit
})

export const SpaceMarkSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("automatic") }),
  Schema.Struct({ kind: Schema.Literal("set"), look: SpaceMarkLookSchema })
]).pipe(Schema.toTaggedUnion("kind"))

const SpacePageSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unbound") }),
  Schema.Struct({ kind: Schema.Literal("bound"), path: Schema.String })
]).pipe(Schema.toTaggedUnion("kind"))

export const SpaceKindSchema = Schema.Literals(SPACE_KINDS)

const SpaceInstructionsSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unwritten") }),
  Schema.Struct({ kind: Schema.Literal("cleared") }),
  Schema.Struct({ kind: Schema.Literal("manual"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("generated"), text: Schema.String })
]).pipe(Schema.toTaggedUnion("kind"))

export const SpaceSchema: Schema.Codec<Space> = withExtras({
  inference: TaskInferencePolicySchema,
  space_id: Schema.NonEmptyString,
  kind: SpaceKindSchema,
  name: Schema.String,
  instructions: SpaceInstructionsSchema,
  page: SpacePageSchema,
  mark: SpaceMarkSchema,
  created_at: IsoDateTimeStringSchema,
  updated_at: IsoDateTimeStringSchema,
  state: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("active") }),
    Schema.Struct({ kind: Schema.Literal("archived"), archived_at: IsoDateTimeStringSchema })
  ]).pipe(Schema.toTaggedUnion("kind"))
})

export const SpaceListResponseSchema: Schema.Codec<SpaceListResponse> = withExtras({
  spaces: Schema.Array(SpaceSchema)
})

const SpaceInstructionsInputSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("cleared") }),
  Schema.Struct({ kind: Schema.Literal("written"), text: SpaceInstructionsTextSchema })
])

export const CreateSpaceInputSchema = Schema.Struct({
  name: SpaceNameSchema,
  instructions: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("unwritten") }),
    ...SpaceInstructionsInputSchema.members
  ]).pipe(Schema.toTaggedUnion("kind"))
})

export const UpdateSpaceInputSchema = Schema.Struct({
  expected: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("latest") }),
    Schema.Struct({ kind: Schema.Literal("at"), updated_at: IsoDateTimeStringSchema })
  ]).pipe(Schema.toTaggedUnion("kind")),
  changes: Schema.Array(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("name"), name: SpaceNameSchema }),
      Schema.Struct({
        kind: Schema.Literal("instructions"),
        instructions: SpaceInstructionsInputSchema.pipe(Schema.toTaggedUnion("kind"))
      }),
      Schema.Struct({ kind: Schema.Literal("mark"), mark: SpaceMarkSchema })
    ]).pipe(Schema.toTaggedUnion("kind"))
  ).check(
    Schema.makeFilter((changes) =>
      changes.length > 0 ? undefined : "a Space update requires at least one field"
    )
  )
})

export const SpaceArchiveResponseSchema: Schema.Codec<SpaceArchiveResponse> = withExtras({
  status: Schema.Literal("archived"),
  space_id: Schema.NonEmptyString
})

export const SpaceEndConflictSchema: Schema.Codec<SpaceEndConflict> = withExtras({
  detail: Schema.String,
  chats: Schema.Array(Schema.Struct({ name: Schema.String, running: ChatRunningWorkSchema }))
})

const LetterSubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("given"), subject: Schema.String })
]).pipe(Schema.toTaggedUnion("kind"))

const spaceUnseenFields = {
  at: IsoDateTimeStringSchema,
  session_id: Schema.NonEmptyString,
  line: Schema.String,
  subject: LetterSubjectSchema
} as const

export const SpaceUnseenEntrySchema = withExtras({
  ...spaceUnseenFields,
  space_id: Schema.NonEmptyString,
  space_title: Schema.String
})

export const LastLineSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("line"), text: Schema.String })
]).pipe(Schema.toTaggedUnion("kind"))

export const SpaceSummarySchema = withExtras({
  updated_at: IsoDateTimeStringSchema,
  key: Schema.NonEmptyString,
  kind: SpaceKindSchema,
  title: Schema.String,
  page: SpacePageSchema,
  live: Schema.Boolean,
  pinned: Schema.Boolean,
  mark: SpaceMarkSchema,
  unseen: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("caught_up") }),
    withExtras({ kind: Schema.Literal("unseen"), ...spaceUnseenFields })
  ]).pipe(Schema.toTaggedUnion("kind")),
  last_line: LastLineSchema
})

const briefFields = {
  space_id: Schema.NonEmptyString,
  space_title: Schema.String,
  stable_key: Schema.NonEmptyString,
  text: Schema.String,
  updated_at: IsoDateTimeStringSchema
} as const

export const SpacesBriefSchema = withExtras({
  done: Schema.Array(withExtras({ ...briefFields, completed_at: IsoDateTimeStringSchema })),
  in_progress: Schema.Array(
    withExtras({
      ...briefFields,
      status: SpaceTaskStatusSchema,
      owner: Schema.Literals(["worker", "user", "external"] as const)
    })
  )
})

export const SpacesOverviewSchema: Schema.Codec<SpacesOverview> = withExtras({
  spaces: Schema.Array(SpaceSummarySchema),
  unseen: Schema.Array(SpaceUnseenEntrySchema),
  brief: SpacesBriefSchema
}).check(
  Schema.makeFilter((overview) => {
    const spaceIds = new Set(overview.spaces.map((space) => space.key))
    if (spaceIds.size !== overview.spaces.length) {
      return { path: ["spaces"], issue: "contains duplicate Space keys" }
    }
    if (!overview.unseen.every((entry) => spaceIds.has(entry.space_id))) {
      return { path: ["unseen"], issue: "references a Space absent from the overview" }
    }
    return undefined
  })
)

const tagged = <const Tag extends string, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields
) => Schema.Struct({ kind: Schema.Literal(tag), ...fields })

export const SpaceAgentStatusSchema = withExtras({
  latest_run: Schema.Union([
    tagged("none", {}),
    tagged("run", { run_id: Schema.NonEmptyString })
  ]).pipe(Schema.toTaggedUnion("kind")),
  last_checked: Schema.Union([
    tagged("never", {}),
    tagged("at", { at: IsoDateTimeStringSchema })
  ]).pipe(Schema.toTaggedUnion("kind")),
  last_report: Schema.Union([tagged("none", {}), tagged("report", { text: Schema.String })]).pipe(
    Schema.toTaggedUnion("kind")
  ),
  woken_by: Schema.Array(Schema.String),
  runs_today: NonNegativeIntSchema,
  runs_cap: NonNegativeIntSchema,
  running: Schema.Union([
    tagged("idle", {}),
    tagged("running", { since: IsoDateTimeStringSchema })
  ]).pipe(Schema.toTaggedUnion("kind")),
  availability: Schema.Literals(["ready", "stale", "unavailable", "error"] as const),
  last_error: Schema.Union([tagged("none", {}), tagged("failed", { error: Schema.String })]).pipe(
    Schema.toTaggedUnion("kind")
  )
})

export const SpaceSessionSchema = withExtras({
  session_id: Schema.NonEmptyString,
  session_ref: Schema.NonEmptyString,
  name: Schema.Union([tagged("untitled", {}), tagged("named", { name: Schema.String })]).pipe(
    Schema.toTaggedUnion("kind")
  ),
  last_line: LastLineSchema,
  summary: Schema.Union([
    tagged("unsummarized", {}),
    tagged("summarized", { text: Schema.String })
  ]).pipe(Schema.toTaggedUnion("kind")),
  last_activity: Schema.String
})

export const SpaceDetailSchema: Schema.Codec<SpaceDetail> = withExtras({
  conversation: Schema.Union([
    tagged("unopened", {}),
    tagged("opened", { session_id: Schema.NonEmptyString })
  ]).pipe(Schema.toTaggedUnion("kind")),
  inference: TaskInferencePolicySchema,
  key: Schema.NonEmptyString,
  title: Schema.String,
  page: SpacePageSchema,
  instructions: SpaceInstructionsSchema,
  agent: Schema.Union([tagged("off", {}), tagged("on", { status: SpaceAgentStatusSchema })]).pipe(
    Schema.toTaggedUnion("kind")
  ),
  sessions: Schema.Array(SpaceSessionSchema),
  work: SpaceSnapshotSchema
}).check(
  Schema.makeFilter((detail) =>
    detail.inference.enabled === (detail.agent.kind === SPACE_AGENT.on)
      ? undefined
      : {
          path: ["agent"],
          issue: "must be present exactly when the Space suggests tasks"
        }
  )
)

export const encodeCreateSpaceRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(CreateSpaceInputSchema)(value, strict).pipe(Effect.map(JSON.stringify))

export const encodeUpdateSpaceRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(UpdateSpaceInputSchema)(value, strict).pipe(Effect.map(JSON.stringify))

export const PinnedSpacesInputSchema: Schema.Codec<PinnedSpacesInput> = Schema.Struct({
  space_ids: Schema.Array(Schema.NonEmptyString)
})

export const encodePinnedSpacesRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(PinnedSpacesInputSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const SpaceConversationResponseSchema: Schema.Codec<SpaceConversationResponse> =
  Schema.Struct({ session_id: Schema.NonEmptyString })
