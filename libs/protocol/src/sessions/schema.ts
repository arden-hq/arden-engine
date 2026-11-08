import { Effect, Schema } from "effect"
import type {
  SessionExportFormat,
  SessionListResponse,
  CreateSessionResponse,
  BranchSessionResponse,
  ClearSessionResponse,
  RenameSessionResponse,
  UpdateSessionModelResponse,
  ArchivedSessionsResponse,
  SessionLifecycleResponse,
  ChatRunningWork,
  SessionEndConflict,
  RevertSessionResponse,
  MoveSessionToSpaceResponse,
  SessionExportResponse,
  ChatFindResponse,
  ChatSearchResponse
} from "./contracts.js"
import { FIND_QUERY_MAX_LENGTH } from "../views/find-text.js"
import { ContextBudgetSnapshotSchema } from "../chat/schema.js"
import { ImageDataSchema, ImageMediaTypeSchema } from "../chat/schema-fields.js"
import {
  IsoDateTimeStringSchema,
  SessionListItemSchema,
  SessionForkOriginSchema,
  SessionTypeSchema,
  withExtras,
  NonNegativeIntSchema,
  PositiveIntSchema
} from "../common/schema.js"

const strict = { onExcessProperty: "error" } as const
const TrimmedTextSchema = Schema.Trimmed.check(Schema.isMinLength(1))
const NullableTrimmedTextSchema = Schema.NullOr(TrimmedTextSchema)
const QueryBooleanSchema = Schema.Union([
  Schema.Boolean,
  Schema.Literals(["true", "false"] as const)
])
const QueryNonNegativeIntSchema = Schema.Union([Schema.Number, Schema.NumberFromString]).check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)
const QueryLimitSchema = QueryNonNegativeIntSchema.check(
  Schema.isBetween({ minimum: 1, maximum: 500 })
)
const SessionListSortSchema = Schema.Literals(["activity", "accessed"] as const)
const SessionListScopeSchema = Schema.Literals(["primary", "agent", "all"] as const)
const SessionListCursorSchema = Schema.Struct({
  at: IsoDateTimeStringSchema,
  session_id: Schema.NonEmptyString
})

const requiredListedSessionKeys = [
  "presentation",
  "public_ref",
  "last_accessed_at",
  "has_unread",
  "space_id",
  "chat_model",
  "session_type",
  "origin_automation_id",
  "parent_session_id",
  "parent_tool_call_id",
  "parent_message_id",
  "parent_run_id",
  "active_run_id",
  "active_turn_id",
  "run_status",
  "checkpoint_seq",
  "latest_event_seq",
  "is_active",
  "pending_approvals_count",
  "pending_connections_count",
  "run_error_code",
  "run_stop_reason"
] as const

export const SessionListQuerySchema = withExtras({
  space_id: Schema.optionalKey(Schema.NonEmptyString),
  inbox: Schema.optionalKey(QueryBooleanSchema),
  scope: Schema.optionalKey(SessionListScopeSchema),
  live: Schema.optionalKey(QueryBooleanSchema),
  parent_session_ids: Schema.optionalKey(Schema.Trimmed.check(Schema.isMinLength(1))),
  limit: Schema.optionalKey(QueryLimitSchema),
  offset: Schema.optionalKey(QueryNonNegativeIntSchema),
  sort: Schema.optionalKey(SessionListSortSchema),
  cursor_at: Schema.optionalKey(IsoDateTimeStringSchema),
  cursor_id: Schema.optionalKey(Schema.NonEmptyString),
  session_ids: Schema.optionalKey(Schema.Trimmed.check(Schema.isMinLength(1))),
  session_ref: Schema.optionalKey(Schema.NonEmptyString)
}).check(
  Schema.makeFilter((query) =>
    (query.cursor_at === undefined) === (query.cursor_id === undefined)
      ? undefined
      : "session-list cursor requires both timestamp and session id"
  )
)

type ListedSessionItem = typeof SessionListItemSchema.Type
type ListedSessionShape = ListedSessionItem &
  Required<Pick<ListedSessionItem, (typeof requiredListedSessionKeys)[number]>>

export const ListedSessionSchema = SessionListItemSchema.pipe(
  Schema.refine(
    (session): session is ListedSessionShape =>
      requiredListedSessionKeys.every((key) => Object.hasOwn(session, key)),
    { message: "missing a field required by the session-list response" }
  )
)

export const SessionListResponseSchema: Schema.Codec<SessionListResponse, unknown> = withExtras({
  sessions: Schema.Array(ListedSessionSchema),
  next_cursor: Schema.NullOr(SessionListCursorSchema)
})

export const CreateSessionRequestSchema = Schema.Struct({
  name: Schema.optionalKey(NullableTrimmedTextSchema),
  space_id: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  chat_model: Schema.optionalKey(Schema.NullOr(TrimmedTextSchema)),
  origin: Schema.optionalKey(Schema.Literals(["capture", "onboarding"]))
})

export const HandCaptureRequestSchema = Schema.Struct({
  capture_id: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  image: Schema.Struct({ media_type: ImageMediaTypeSchema, data: ImageDataSchema }),
  note: Schema.String.check(Schema.isMaxLength(4_000))
})

export const HandCaptureResponseSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("moved"),
    session_id: Schema.NonEmptyString,
    name: Schema.String,
    line: Schema.String,
    client_id: Schema.NonEmptyString
  }),
  Schema.Struct({
    kind: Schema.Literal("kept"),
    session_id: Schema.NonEmptyString,
    line: Schema.NullOr(Schema.String)
  })
])

export const encodeHandCaptureRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(HandCaptureRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const CreateSessionResponseSchema: Schema.Codec<CreateSessionResponse> = withExtras({
  session_id: Schema.NonEmptyString,
  name: Schema.NullOr(Schema.String),
  started_at: IsoDateTimeStringSchema,
  last_activity: IsoDateTimeStringSchema,
  message_count: NonNegativeIntSchema,
  space_id: Schema.NullOr(Schema.String),
  chat_model: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.Literals(["capture", "onboarding"] as const))
})

export const BranchSessionRequestSchema = Schema.Struct({
  disposition: Schema.optionalKey(Schema.Literals(["retained", "disposable"])),
  request_id: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
  ),
  share_resources: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(NullableTrimmedTextSchema),
  up_to_message_id: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString))
})

export const BranchSessionResponseSchema: Schema.Codec<BranchSessionResponse> = withExtras({
  fork_origin: Schema.optionalKey(Schema.NullOr(SessionForkOriginSchema)),
  session_id: Schema.NonEmptyString,
  name: Schema.NullOr(Schema.String),
  started_at: IsoDateTimeStringSchema,
  last_activity: IsoDateTimeStringSchema,
  space_id: Schema.NullOr(Schema.String)
})

export const RenameSessionRequestSchema = Schema.Struct({
  name: TrimmedTextSchema
})

export const RenameSessionResponseSchema: Schema.Codec<RenameSessionResponse> = withExtras({
  session_id: Schema.NonEmptyString,
  name: Schema.String
})

export const UpdateSessionModelRequestSchema = Schema.Struct({
  chat_model: Schema.NullOr(TrimmedTextSchema)
})

export const UpdateSessionModelResponseSchema: Schema.Codec<UpdateSessionModelResponse> =
  withExtras({
    session_id: Schema.NonEmptyString,
    chat_model: Schema.NullOr(Schema.String),
    context_budget: ContextBudgetSnapshotSchema
  })

export const ArchivedSessionSchema = withExtras({
  session_id: Schema.NonEmptyString,
  public_ref: Schema.NullOr(Schema.String),
  started_at: IsoDateTimeStringSchema,
  last_activity: IsoDateTimeStringSchema,
  last_accessed_at: Schema.NullOr(IsoDateTimeStringSchema),
  name: Schema.NullOr(Schema.String),
  archived_at: IsoDateTimeStringSchema,
  first_line: Schema.NullOr(Schema.String),
  message_count: NonNegativeIntSchema,
  space_id: Schema.NullOr(Schema.String),
  chat_model: Schema.NullOr(Schema.String),
  session_type: SessionTypeSchema,
  origin_automation_id: Schema.NullOr(Schema.String),
  parent_session_id: Schema.NullOr(Schema.String),
  parent_tool_call_id: Schema.NullOr(Schema.String),
  parent_message_id: Schema.NullOr(Schema.String),
  parent_run_id: Schema.NullOr(Schema.String)
})

export const ArchivedSessionsResponseSchema: Schema.Codec<ArchivedSessionsResponse> = withExtras({
  sessions: Schema.Array(ArchivedSessionSchema)
})

export const SessionLifecycleResponseSchema: Schema.Codec<SessionLifecycleResponse> = withExtras({
  status: Schema.Literals(["archived", "restored", "continued", "deleted"] as const),
  session_id: Schema.NonEmptyString
})

const RunningCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const ChatRunningWorkSchema: Schema.Codec<ChatRunningWork> = withExtras({
  replies: RunningCountSchema,
  agents: RunningCountSchema,
  automations: RunningCountSchema,
  workflows: RunningCountSchema,
  commands: RunningCountSchema
})

export const SessionEndConflictSchema: Schema.Codec<SessionEndConflict> = withExtras({
  detail: Schema.String,
  running: Schema.NullOr(ChatRunningWorkSchema)
})

/** `stop=true` on an archive or a permanent delete: stop the chat's running work first. */
export const SessionEndQuerySchema = Schema.Struct({
  stop: Schema.optionalKey(QueryBooleanSchema)
})

export const ClearSessionRequestSchema = Schema.Struct({
  session_id: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString))
})

export const ClearSessionResponseSchema: Schema.Codec<ClearSessionResponse> = withExtras({
  status: Schema.Literal("cleared"),
  session_id: Schema.NullOr(Schema.String)
})

export const RevertSessionRequestSchema = Schema.Struct({
  session_id: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  turns: Schema.optionalKey(PositiveIntSchema),
  message_id: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString))
})

export const RevertSessionResponseSchema: Schema.Codec<RevertSessionResponse> = withExtras({
  user_message: Schema.String,
  reverted_count: PositiveIntSchema
})

export const MoveSessionToSpaceRequestSchema = Schema.Struct({
  space_id: Schema.NullOr(Schema.NonEmptyString)
})

export const MoveSessionToSpaceResponseSchema: Schema.Codec<MoveSessionToSpaceResponse> =
  withExtras({
    session_id: Schema.NonEmptyString,
    space_id: Schema.NullOr(Schema.String)
  })

export const SessionExportFormatSchema = Schema.Literals([
  "archive",
  "markdown",
  "json",
  "jsonl"
] as const)

export const SessionExportQuerySchema = withExtras({
  format: SessionExportFormatSchema
})

const exportMediaType = {
  archive: "application/vnd.arden.session+json",
  json: "application/json",
  jsonl: "application/x-ndjson",
  markdown: "text/markdown"
} as const satisfies Record<SessionExportFormat, string>

export const SessionExportResponseSchema: Schema.Codec<SessionExportResponse> = withExtras({
  format: SessionExportFormatSchema,
  filename: Schema.NonEmptyString,
  media_type: Schema.Literals([
    "application/vnd.arden.session+json",
    "application/json",
    "application/x-ndjson",
    "text/markdown"
  ] as const),
  content: Schema.String,
  warnings: Schema.Array(Schema.String)
}).check(
  Schema.makeFilter((response) => {
    return response.media_type === exportMediaType[response.format]
      ? undefined
      : "session export format and media type must match"
  })
)

/** A find box's query: a few words, trimmed, never blank. */
export const FindQueryTextSchema = Schema.Trimmed.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(FIND_QUERY_MAX_LENGTH)
)

export const ChatFindQuerySchema = withExtras({
  q: FindQueryTextSchema
})

export const ChatFindResponseSchema: Schema.Codec<ChatFindResponse> = withExtras({
  hits: Schema.Array(
    withExtras({
      message_id: Schema.NonEmptyString,
      seq: NonNegativeIntSchema,
      count: PositiveIntSchema
    })
  ),
  truncated: Schema.Boolean
})

export const ChatSearchQuerySchema = withExtras({
  q: FindQueryTextSchema
})

export const ChatSearchResponseSchema: Schema.Codec<ChatSearchResponse> = withExtras({
  hits: Schema.Array(
    withExtras({
      session_id: Schema.NonEmptyString,
      session_name: Schema.NullOr(Schema.String),
      message_id: Schema.NonEmptyString,
      snippet: Schema.String,
      ranges: Schema.Array(Schema.Tuple([NonNegativeIntSchema, NonNegativeIntSchema])),
      created_at: IsoDateTimeStringSchema
    })
  ),
  has_more: Schema.Boolean
})

export { SessionTriageDecisionSchema } from "../common/schema.js"

export const SessionTriageActionRequestSchema = Schema.Struct({
  action: Schema.Literals(["dismiss", "accept", "undo"] as const)
})

export const decodeSessionListQueryEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(SessionListQuerySchema)(value).pipe(
    Effect.map((query) => ({
      ...query,
      inbox: query.inbox === true || query.inbox === "true",
      scope: query.scope ?? "all",
      live: query.live === true || query.live === "true",
      limit: query.limit ?? 100,
      ...(query.offset === undefined ? {} : { offset: query.offset }),
      sort: query.sort ?? "activity"
    }))
  )

export const decodeCreateSessionRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(CreateSessionRequestSchema)(value, strict)

export const decodeBranchSessionRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(BranchSessionRequestSchema)(value, strict)

export const decodeRenameSessionRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(RenameSessionRequestSchema)(value, strict)

export const decodeUpdateSessionModelRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(UpdateSessionModelRequestSchema)(value, strict)

export const decodeClearSessionRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(ClearSessionRequestSchema)(value, strict)

export const decodeRevertSessionRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(RevertSessionRequestSchema)(value, strict)

export const encodeCreateSessionRequestEffect = (value: unknown) =>
  decodeCreateSessionRequestEffect(value).pipe(Effect.map(JSON.stringify))

export const encodeBranchSessionRequestEffect = (value: unknown) =>
  decodeBranchSessionRequestEffect(value).pipe(Effect.map(JSON.stringify))

export const encodeRenameSessionRequestEffect = (value: unknown) =>
  decodeRenameSessionRequestEffect(value).pipe(Effect.map(JSON.stringify))

export const encodeUpdateSessionModelRequestEffect = (value: unknown) =>
  decodeUpdateSessionModelRequestEffect(value).pipe(Effect.map(JSON.stringify))

export const encodeClearSessionRequestEffect = (value: unknown) =>
  decodeClearSessionRequestEffect(value).pipe(Effect.map(JSON.stringify))

export const encodeRevertSessionRequestEffect = (value: unknown) =>
  decodeRevertSessionRequestEffect(value).pipe(Effect.map(JSON.stringify))

export const encodeSessionTriageActionRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(SessionTriageActionRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeMoveSessionToSpaceRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(MoveSessionToSpaceRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )
