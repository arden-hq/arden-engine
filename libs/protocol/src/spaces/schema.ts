import { Effect, Schema, SchemaTransformation } from "effect"
import { IsoDateTimeStringSchema, withExtras, NonNegativeIntSchema } from "../common/schema.js"
import { APPROVAL_MODES } from "../permissions/modes.js"
import { ChatRunningWorkSchema } from "../sessions/schema.js"
import { SpaceSnapshotSchema, SpaceTaskStatusSchema } from "./work/schema.js"
import { SPACE_MARK_COLOURS, SPACE_MARK_MEDIA } from "./contracts.js"
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
const TrimmedNameSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))
const nullableBoundedText = (maximum: number) =>
  Schema.NullOr(Schema.String.check(Schema.isMaxLength(maximum)))

/** Same three modes a Chat has; the Space applies one to its task workers. */
export const SpaceApprovalModeSchema = Schema.Literals(APPROVAL_MODES)
export const TaskInferencePolicySchema = Schema.Struct({
  enabled: Schema.Boolean
})

const unit = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
export const SpaceMarkLookSchema = Schema.Struct({
  colour: Schema.NullOr(Schema.Literals(SPACE_MARK_COLOURS)),
  medium: Schema.Literals(SPACE_MARK_MEDIA),
  zoom: unit,
  aberration: unit,
  focus: unit
})

const legacySpaceMarkLook = Schema.Struct({
  colour: Schema.NullOr(Schema.Literals([...SPACE_MARK_COLOURS, "white", "black"] as const)),
  medium: Schema.Literals([...SPACE_MARK_MEDIA, "ink"] as const),
  zoom: unit,
  aberration: unit,
  focus: unit
}).pipe(
  Schema.decodeTo(
    SpaceMarkLookSchema,
    SchemaTransformation.transform({
      decode: (look) => ({
        ...look,
        colour:
          look.colour === "white" || look.colour === "black" ? ("mono" as const) : look.colour,
        medium: look.medium === "ink" ? ("pool" as const) : look.medium
      }),
      encode: (look) => look
    })
  )
)

/** What a stored mark may hold: the current shape, or one from before the migration ran. The
 *  current shape comes first, so encoding writes it. */
export const StoredSpaceMarkLookSchema = Schema.Union([SpaceMarkLookSchema, legacySpaceMarkLook])

export const SpaceInstructionsSourceSchema = Schema.Literals(["manual", "generated"] as const)

export const SpaceSchema: Schema.Codec<Space> = withExtras({
  inference: TaskInferencePolicySchema,
  space_id: Schema.NonEmptyString,
  name: Schema.String,
  instructions: Schema.NullOr(Schema.String),
  instructions_source: Schema.NullOr(SpaceInstructionsSourceSchema),
  page_path: Schema.NullOr(Schema.String),
  mark: Schema.NullOr(SpaceMarkLookSchema),
  created_at: IsoDateTimeStringSchema,
  updated_at: IsoDateTimeStringSchema,
  archived_at: Schema.NullOr(IsoDateTimeStringSchema)
}).check(
  Schema.makeFilter((space) =>
    Object.hasOwn(space, "page_id")
      ? { path: ["page_id"], issue: "is not part of the Space API" }
      : undefined
  )
)

export const SpaceListResponseSchema: Schema.Codec<SpaceListResponse> = withExtras({
  spaces: Schema.Array(SpaceSchema)
})

export const CreateSpaceInputSchema = Schema.Struct({
  name: TrimmedNameSchema,
  instructions: Schema.optionalKey(nullableBoundedText(20_000)),
  // Effect ignores unknown keys by default. Reject the old Wiki attachment field explicitly.
  page_path: Schema.optionalKey(Schema.Never)
})

export const UpdateSpaceInputSchema = Schema.Struct({
  expected_updated_at: Schema.optionalKey(IsoDateTimeStringSchema),
  name: Schema.optionalKey(TrimmedNameSchema),
  instructions: Schema.optionalKey(nullableBoundedText(20_000)),
  page_path: Schema.optionalKey(nullableBoundedText(1_000)),
  mark: Schema.optionalKey(Schema.NullOr(SpaceMarkLookSchema))
}).check(
  Schema.makeFilter((input) =>
    Object.keys(input).some((key) => key !== "expected_updated_at")
      ? undefined
      : "a Space update requires at least one field"
  )
)

export const SpaceArchiveResponseSchema: Schema.Codec<SpaceArchiveResponse> = withExtras({
  status: Schema.Literal("archived"),
  space_id: Schema.NonEmptyString
})

export const SpaceEndConflictSchema: Schema.Codec<SpaceEndConflict> = withExtras({
  detail: Schema.String,
  chats: Schema.Array(Schema.Struct({ name: Schema.String, running: ChatRunningWorkSchema }))
})

export const SpaceUnseenSchema = withExtras({
  at: IsoDateTimeStringSchema,
  session_id: Schema.NonEmptyString,
  line: Schema.String,
  subject: Schema.NullOr(Schema.String)
})

export const SpaceUnseenEntrySchema = withExtras({
  at: IsoDateTimeStringSchema,
  session_id: Schema.NonEmptyString,
  line: Schema.String,
  subject: Schema.NullOr(Schema.String),
  space_id: Schema.NonEmptyString,
  space_title: Schema.String
})

export const SpaceSummarySchema = withExtras({
  updated_at: IsoDateTimeStringSchema,
  key: Schema.NonEmptyString,
  title: Schema.String,
  page_path: Schema.NullOr(Schema.String),
  live: Schema.Boolean,
  /** The owner placed it: it stands among the first, in their order. */
  pinned: Schema.Boolean,
  mark: Schema.NullOr(SpaceMarkLookSchema),
  unseen: Schema.NullOr(SpaceUnseenSchema),
  last_line: Schema.optionalKey(Schema.NullOr(Schema.String))
})

export const SpaceBriefItemSchema = withExtras({
  space_id: Schema.NonEmptyString,
  space_title: Schema.String,
  stable_key: Schema.NonEmptyString,
  text: Schema.String,
  status: Schema.optionalKey(SpaceTaskStatusSchema),
  owner: Schema.optionalKey(Schema.Literals(["worker", "user", "external"] as const)),
  completed_at: Schema.NullOr(IsoDateTimeStringSchema),
  updated_at: IsoDateTimeStringSchema
})

export const SpacesBriefSchema = withExtras({
  done: Schema.Array(SpaceBriefItemSchema),
  in_progress: Schema.Array(SpaceBriefItemSchema)
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

export const SpaceAgentStatusSchema = withExtras({
  latest_run_id: Schema.NullOr(Schema.NonEmptyString),
  last_checked: Schema.NullOr(IsoDateTimeStringSchema),
  next_check: Schema.NullOr(IsoDateTimeStringSchema),
  last_report: Schema.NullOr(Schema.String),
  woken_by: Schema.Array(Schema.String),
  runs_today: NonNegativeIntSchema,
  runs_cap: NonNegativeIntSchema,
  running_since: Schema.NullOr(IsoDateTimeStringSchema),
  availability: Schema.Literals(["ready", "stale", "unavailable", "error"] as const),
  last_error: Schema.NullOr(Schema.String)
})

export const SpaceSessionSchema = withExtras({
  session_id: Schema.NonEmptyString,
  session_ref: Schema.optionalKey(Schema.NonEmptyString),
  name: Schema.NullOr(Schema.String),
  last_line: Schema.optionalKey(Schema.NullOr(Schema.String)),
  summary: Schema.optionalKey(Schema.NullOr(Schema.String)),
  last_activity: Schema.optionalKey(Schema.String)
})

const SpaceOverviewSchema = withExtras({
  now: Schema.String,
  next: Schema.Array(Schema.String),
  updated_at: IsoDateTimeStringSchema,
  revision_id: Schema.NullOr(Schema.Int),
  source_freshness: Schema.Literals(["fresh", "stale", "unknown"])
})

export const SpaceDetailSchema: Schema.Codec<SpaceDetail> = withExtras({
  conversation_session_id: Schema.NullOr(Schema.NonEmptyString),
  inference: TaskInferencePolicySchema,
  key: Schema.NonEmptyString,
  title: Schema.String,
  page_path: Schema.NullOr(Schema.String),
  instructions: Schema.NullOr(Schema.String),
  agent: Schema.NullOr(SpaceAgentStatusSchema),
  sessions: Schema.Array(SpaceSessionSchema),
  overview: Schema.optionalKey(Schema.NullOr(SpaceOverviewSchema)),
  work: SpaceSnapshotSchema
}).check(
  Schema.makeFilter((detail) =>
    !detail.inference.enabled === (detail.agent === null)
      ? undefined
      : {
          path: ["agent"],
          issue: "must be present exactly when the Space suggests tasks"
        }
  )
)

export const encodeCreateSpaceRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(CreateSpaceInputSchema)(value, strict).pipe(Effect.map(JSON.stringify))

export const encodeUpdateSpaceRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(UpdateSpaceInputSchema)(value, strict).pipe(Effect.map(JSON.stringify))

export const PinnedSpacesInputSchema: Schema.Codec<PinnedSpacesInput> = Schema.Struct({
  space_ids: Schema.Array(Schema.NonEmptyString)
})

export const encodePinnedSpacesRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(PinnedSpacesInputSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const SpaceConversationResponseSchema: Schema.Codec<SpaceConversationResponse> =
  Schema.Struct({ session_id: Schema.NonEmptyString })
