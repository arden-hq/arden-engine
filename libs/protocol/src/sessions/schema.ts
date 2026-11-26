import { Effect, Schema, type SchemaAST } from "effect"
import type {
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
  StartOnboardingResponse,
  SessionExportResponse,
  ChatFindResponse,
  ChatSearchResponse
} from "./contracts.js"
import {
  CHAT_SEARCH_MATCH,
  HAND_CAPTURE,
  SESSION_EXPORT_FORMAT,
  SESSION_EXPORT_MEDIA_TYPE,
  SESSION_LIST_FILTER,
  SESSION_LIST_NEXT,
  SESSION_LIST_PAGE,
  SESSION_LIST_SORT,
  SESSION_LIST_SCOPE,
  SESSION_FORK_DISPOSITION,
  SESSION_TRIAGE_ACTION
} from "./contracts.js"
import { QueryBooleanTextSchema } from "../common/routes.js"
import { FIND_QUERY_MAX_LENGTH } from "../views/find-text.js"
import { ContextBudgetSnapshotSchema } from "../chat/schema.js"
import { ImageDataSchema, ImageMediaTypeSchema } from "../chat/schema-fields.js"
import {
  IsoDateTimeStringSchema,
  SessionTypeSchema,
  withExtras,
  NonNegativeIntSchema,
  PositiveIntSchema
} from "../common/schema.js"
import {
  BRANCH_REQUEST,
  CAPTURE_LINE,
  CLEARED,
  REVERT_TO,
  RUNNING_WORK,
  SEARCH_PREVIEW,
  SESSION_TARGET
} from "./contracts.js"
import {
  FirstLineSchema,
  LinkedAutomationSchema,
  ListedSessionSchema,
  ParentMessageSchema,
  SessionChatModelSchema,
  SessionNameSchema,
  SessionOriginSchema,
  SessionParentSchema,
  SessionSpaceSchema,
  SessionChatModelInputSchema,
  SessionNameInputSchema,
  SessionSpaceInputSchema
} from "./state-schema.js"

const strict: SchemaAST.ParseOptions = { onExcessProperty: "error" }
const TrimmedTextSchema = Schema.Trimmed.check(Schema.isMinLength(1))
const QueryBooleanSchema = Schema.Union([Schema.Boolean, QueryBooleanTextSchema])
const QueryNonNegativeIntSchema = Schema.Union([Schema.Number, Schema.NumberFromString]).check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)
const QueryLimitSchema = QueryNonNegativeIntSchema.check(
  Schema.isBetween({ minimum: 1, maximum: 500 })
)
const SessionListSortSchema = Schema.Literals(Object.values(SESSION_LIST_SORT))
const SessionListScopeSchema = Schema.Literals(Object.values(SESSION_LIST_SCOPE))
const SessionListCursorSchema = Schema.Struct({
  at: IsoDateTimeStringSchema,
  session_id: Schema.NonEmptyString
})

const SessionIdListSchema = Schema.Trimmed.check(Schema.isMinLength(1))

const listFilters = [
  { filter: Schema.Literal(SESSION_LIST_FILTER.all) },
  { filter: Schema.Literal(SESSION_LIST_FILTER.space), space_id: Schema.NonEmptyString },
  {
    filter: Schema.Literal(SESSION_LIST_FILTER.children),
    parent_session_ids: SessionIdListSchema
  },
  { filter: Schema.Literal(SESSION_LIST_FILTER.sessions), session_ids: SessionIdListSchema },
  { filter: Schema.Literal(SESSION_LIST_FILTER.ref), session_ref: Schema.NonEmptyString }
] as const

const listPages = [
  { page: Schema.Literal(SESSION_LIST_PAGE.first) },
  { page: Schema.Literal(SESSION_LIST_PAGE.offset), offset: QueryNonNegativeIntSchema },
  {
    page: Schema.Literal(SESSION_LIST_PAGE.after),
    cursor_at: IsoDateTimeStringSchema,
    cursor_id: Schema.NonEmptyString
  }
] as const

const listQueryFields = {
  scope: SessionListScopeSchema,
  live: QueryBooleanSchema,
  limit: QueryLimitSchema,
  sort: SessionListSortSchema
}

export const SessionListQuerySchema = Schema.Union(
  listFilters.flatMap((filter) =>
    listPages.map((page) => withExtras({ ...listQueryFields, ...filter, ...page }))
  )
)

export const SessionListResponseSchema: Schema.Codec<SessionListResponse> = withExtras({
  sessions: Schema.Array(ListedSessionSchema),
  next: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(SESSION_LIST_NEXT.end) }),
    Schema.Struct({ kind: Schema.Literal(SESSION_LIST_NEXT.more), cursor: SessionListCursorSchema })
  ])
})

export const CreateSessionRequestSchema = Schema.Struct({
  name: SessionNameInputSchema,
  space: SessionSpaceInputSchema,
  chat_model: SessionChatModelInputSchema,
  origin: SessionOriginSchema
})

export const HandCaptureRequestSchema = Schema.Struct({
  capture_id: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  image: Schema.Struct({ media_type: ImageMediaTypeSchema, data: ImageDataSchema }),
  note: Schema.String.check(Schema.isMaxLength(4_000))
})

export const HandCaptureResponseSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(HAND_CAPTURE.moved),
    session_id: Schema.NonEmptyString,
    name: Schema.String,
    line: Schema.String,
    client_id: Schema.NonEmptyString
  }),
  Schema.Struct({
    kind: Schema.Literal(HAND_CAPTURE.kept),
    session_id: Schema.NonEmptyString,
    line: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(CAPTURE_LINE.none) }),
      Schema.Struct({ kind: Schema.Literal(CAPTURE_LINE.line), text: Schema.String })
    ])
  })
])

export const encodeHandCaptureRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(HandCaptureRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const CreateSessionResponseSchema: Schema.Codec<CreateSessionResponse> = withExtras({
  session_id: Schema.NonEmptyString,
  name: SessionNameSchema,
  started_at: IsoDateTimeStringSchema,
  last_activity: IsoDateTimeStringSchema,
  message_count: NonNegativeIntSchema,
  space: SessionSpaceSchema,
  chat_model: SessionChatModelSchema,
  origin: SessionOriginSchema
})

export const BranchSessionRequestSchema = Schema.Struct({
  disposition: Schema.Literals(Object.values(SESSION_FORK_DISPOSITION)),
  request: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(BRANCH_REQUEST.once) }),
    Schema.Struct({
      kind: Schema.Literal(BRANCH_REQUEST.keyed),
      request_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
    })
  ]),
  share_resources: Schema.Boolean,
  name: SessionNameInputSchema,
  up_to: ParentMessageSchema
})

export const BranchSessionResponseSchema: Schema.Codec<BranchSessionResponse> = withExtras({
  session_id: Schema.NonEmptyString,
  name: SessionNameSchema,
  started_at: IsoDateTimeStringSchema,
  last_activity: IsoDateTimeStringSchema,
  space: SessionSpaceSchema
})

export const RenameSessionRequestSchema = Schema.Struct({
  name: TrimmedTextSchema
})

export const RenameSessionResponseSchema: Schema.Codec<RenameSessionResponse> = withExtras({
  session_id: Schema.NonEmptyString,
  name: Schema.String
})

export const UpdateSessionModelRequestSchema = Schema.Struct({
  chat_model: SessionChatModelInputSchema
})

export const UpdateSessionModelResponseSchema: Schema.Codec<UpdateSessionModelResponse> =
  withExtras({
    session_id: Schema.NonEmptyString,
    chat_model: SessionChatModelSchema,
    context_budget: ContextBudgetSnapshotSchema
  })

export const ArchivedSessionSchema = withExtras({
  session_id: Schema.NonEmptyString,
  public_ref: Schema.String,
  started_at: IsoDateTimeStringSchema,
  last_activity: IsoDateTimeStringSchema,
  name: SessionNameSchema,
  archived_at: IsoDateTimeStringSchema,
  first_line: FirstLineSchema,
  message_count: NonNegativeIntSchema,
  space: SessionSpaceSchema,
  chat_model: SessionChatModelSchema,
  session_type: SessionTypeSchema,
  origin_automation: LinkedAutomationSchema,
  parent: SessionParentSchema
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
  running: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(RUNNING_WORK.none) }),
    Schema.Struct({ kind: Schema.Literal(RUNNING_WORK.running), work: ChatRunningWorkSchema })
  ])
})

export const SessionEndQuerySchema = Schema.Struct({
  stop: QueryBooleanSchema
})

const SessionTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(SESSION_TARGET.latest) }),
  Schema.Struct({ kind: Schema.Literal(SESSION_TARGET.session), session_id: Schema.NonEmptyString })
])

export const ClearSessionRequestSchema = Schema.Struct({
  target: SessionTargetSchema
})

export const ClearSessionResponseSchema: Schema.Codec<ClearSessionResponse> = withExtras({
  status: Schema.Literal("cleared"),
  cleared: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(CLEARED.none) }),
    Schema.Struct({ kind: Schema.Literal(CLEARED.session), session_id: Schema.String })
  ])
})

export const RevertSessionRequestSchema = Schema.Struct({
  target: SessionTargetSchema,
  to: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(REVERT_TO.turns), turns: PositiveIntSchema }),
    Schema.Struct({
      kind: Schema.Literal(REVERT_TO.message),
      message_id: Schema.NonEmptyString
    })
  ])
})

export const RevertSessionResponseSchema: Schema.Codec<RevertSessionResponse> = withExtras({
  user_message: Schema.String,
  reverted_count: PositiveIntSchema
})

export const MoveSessionToSpaceRequestSchema = Schema.Struct({
  space: SessionSpaceInputSchema
})

export const StartOnboardingResponseSchema: Schema.Codec<StartOnboardingResponse> = withExtras({
  session_id: Schema.NonEmptyString,
  started: Schema.Boolean
})

export const MoveSessionToSpaceResponseSchema: Schema.Codec<MoveSessionToSpaceResponse> =
  withExtras({
    session_id: Schema.NonEmptyString,
    space: SessionSpaceSchema
  })

export const SessionExportFormatSchema = Schema.Literals(Object.values(SESSION_EXPORT_FORMAT))

export const SessionExportQuerySchema = withExtras({
  format: SessionExportFormatSchema
})

export const SessionExportResponseSchema: Schema.Codec<SessionExportResponse> = withExtras({
  format: SessionExportFormatSchema,
  filename: Schema.NonEmptyString,
  media_type: Schema.Literals(Object.values(SESSION_EXPORT_MEDIA_TYPE)),
  content: Schema.String,
  warnings: Schema.Array(Schema.String)
}).check(
  Schema.makeFilter((response) => {
    return response.media_type === SESSION_EXPORT_MEDIA_TYPE[response.format]
      ? undefined
      : "session export format and media type must match"
  })
)

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

const RangesSchema = Schema.Array(Schema.Tuple([NonNegativeIntSchema, NonNegativeIntSchema]))

const ChatSearchHitSchema = withExtras({
  message_id: Schema.NonEmptyString,
  snippet: Schema.String,
  ranges: RangesSchema,
  created_at: IsoDateTimeStringSchema
})

const chatSearchBase = {
  session_id: Schema.NonEmptyString,
  session_name: SessionNameSchema,
  name_ranges: RangesSchema,
  last_activity: IsoDateTimeStringSchema
}

export const ChatSearchResponseSchema: Schema.Codec<ChatSearchResponse> = withExtras({
  chats: Schema.Array(
    Schema.Union([
      withExtras({
        ...chatSearchBase,
        match: Schema.Literal(CHAT_SEARCH_MATCH.message),
        hit: ChatSearchHitSchema
      }),
      withExtras({
        ...chatSearchBase,
        match: Schema.Literal(CHAT_SEARCH_MATCH.name),
        preview: Schema.Union([
          Schema.Struct({ kind: Schema.Literal(SEARCH_PREVIEW.none) }),
          Schema.Struct({ kind: Schema.Literal(SEARCH_PREVIEW.message), hit: ChatSearchHitSchema })
        ])
      })
    ])
  ),
  has_more: Schema.Boolean
})

export * from "./state-schema.js"

export const SessionTriageActionRequestSchema = Schema.Struct({
  action: Schema.Literals(Object.values(SESSION_TRIAGE_ACTION))
})

export const decodeCreateSessionRequestEffect = (
  value: unknown
): Effect.Effect<
  Schema.Schema.Type<typeof CreateSessionRequestSchema>,
  Schema.SchemaError,
  never
> => Schema.decodeUnknownEffect(CreateSessionRequestSchema)(value, strict)

export const decodeBranchSessionRequestEffect = (
  value: unknown
): Effect.Effect<
  Schema.Schema.Type<typeof BranchSessionRequestSchema>,
  Schema.SchemaError,
  never
> => Schema.decodeUnknownEffect(BranchSessionRequestSchema)(value, strict)

export const decodeRenameSessionRequestEffect = (
  value: unknown
): Effect.Effect<{ readonly name: string }, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(RenameSessionRequestSchema)(value, strict)

export const decodeUpdateSessionModelRequestEffect = (
  value: unknown
): Effect.Effect<
  Schema.Schema.Type<typeof UpdateSessionModelRequestSchema>,
  Schema.SchemaError,
  never
> => Schema.decodeUnknownEffect(UpdateSessionModelRequestSchema)(value, strict)

export const decodeClearSessionRequestEffect = (
  value: unknown
): Effect.Effect<Schema.Schema.Type<typeof ClearSessionRequestSchema>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(ClearSessionRequestSchema)(value, strict)

export const decodeRevertSessionRequestEffect = (
  value: unknown
): Effect.Effect<
  Schema.Schema.Type<typeof RevertSessionRequestSchema>,
  Schema.SchemaError,
  never
> => Schema.decodeUnknownEffect(RevertSessionRequestSchema)(value, strict)

export const encodeCreateSessionRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  decodeCreateSessionRequestEffect(value).pipe(Effect.map(JSON.stringify))

export const encodeBranchSessionRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  decodeBranchSessionRequestEffect(value).pipe(Effect.map(JSON.stringify))

export const encodeRenameSessionRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  decodeRenameSessionRequestEffect(value).pipe(Effect.map(JSON.stringify))

export const encodeUpdateSessionModelRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  decodeUpdateSessionModelRequestEffect(value).pipe(Effect.map(JSON.stringify))

export const encodeClearSessionRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  decodeClearSessionRequestEffect(value).pipe(Effect.map(JSON.stringify))

export const encodeRevertSessionRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  decodeRevertSessionRequestEffect(value).pipe(Effect.map(JSON.stringify))

export const encodeSessionTriageActionRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(SessionTriageActionRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeMoveSessionToSpaceRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(MoveSessionToSpaceRequestSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )
