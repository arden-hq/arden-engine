import { Effect, Schema } from "effect"
import { BrowseScopeSchema } from "./session-browse-scope.js"

const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100
const DEFAULT_MESSAGE_LIMIT = 50
const MAX_MESSAGE_LIMIT = 200
const DEFAULT_CONTENT_CHARS = 400
export const MAX_CONTENT_CHARS = 4_000
export const MAX_ACTIONS_LIMIT = 50
export const MAX_SINGLE_CONTENT_CHARS = 20_000

const LimitSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIST_LIMIT }))
  .annotate({
    description: `Maximum sessions to return, from 1 to ${MAX_LIST_LIMIT}. Defaults to ${DEFAULT_LIST_LIMIT}.`
  })
  .pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_LIST_LIMIT)))

const OffsetSchema = Schema.Natural.annotate({
  description: "Number of newer sessions to skip. Defaults to 0."
}).pipe(Schema.withDecodingDefault(Effect.succeed(0)))

const WithinDaysSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })).annotate({
  description: "Only include sessions active within the last N days. Omit for all active sessions."
})

export const ListParametersSchema = Schema.Struct({
  limit: LimitSchema,
  offset: OffsetSchema,
  within_days: Schema.optionalKey(WithinDaysSchema),
  scope: Schema.optionalKey(BrowseScopeSchema)
})

const SessionRefSchema = Schema.NonEmptyString.check(Schema.isMaxLength(200)).annotate({
  description:
    "Exact session_ref from session_list, session_search_transcripts, or one the user or Memory named."
})

const MessageLimitSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_MESSAGE_LIMIT })
)
  .annotate({
    description: `Maximum messages to return, from 1 to ${MAX_MESSAGE_LIMIT}; actions view clamps to ${MAX_ACTIONS_LIMIT}. Defaults to ${DEFAULT_MESSAGE_LIMIT}.`
  })
  .pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_MESSAGE_LIMIT)))

const ContentCharsSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 50, maximum: MAX_SINGLE_CONTENT_CHARS })
)
  .annotate({
    description: `Maximum characters per message, from 50 to ${MAX_CONTENT_CHARS}, or up to ${MAX_SINGLE_CONTENT_CHARS} when limit is 1; larger values are clamped to ${MAX_CONTENT_CHARS} otherwise. Defaults to ${DEFAULT_CONTENT_CHARS}.`
  })
  .pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_CONTENT_CHARS)))

const MessageRoleSchema = Schema.Literals([
  "system",
  "user",
  "interaction",
  "assistant",
  "tool"
] as const)

const READ_VIEW = { transcript: "transcript", actions: "actions" } as const

export const ReadParametersSchema = Schema.Struct({
  session_ref: SessionRefSchema,
  view: Schema.optionalKey(
    Schema.Literals(Object.values(READ_VIEW)).annotate({
      description:
        "Use actions to list recorded tool calls with arguments and results. Defaults to transcript."
    })
  ),
  action_turn_id: Schema.optionalKey(
    Schema.NonEmptyString.annotate({
      description: "For view=actions only. Restrict to this recorded turn_id from a chat read."
    })
  ),
  before_action: Schema.optionalKey(
    Schema.Natural.annotate({
      description: "For view=actions only. before_action from next_args of a prior actions page."
    })
  ),
  limit: MessageLimitSchema,
  content_chars: ContentCharsSchema,
  role_filter: Schema.optionalKey(
    Schema.Array(MessageRoleSchema).check(Schema.isUnique()).annotate({
      description:
        "Transcript view only; not used with view=actions. Return only these message roles from the selected page. Omit to include every role."
    })
  ),
  after_seq: Schema.optionalKey(
    Schema.Natural.annotate({
      description:
        "Transcript view only; not used with view=actions. Return the next page after this message sequence. Cannot be combined with another cursor."
    })
  ),
  before_seq: Schema.optionalKey(
    Schema.Natural.annotate({
      description:
        "Transcript view only; not used with view=actions. Return the previous page before this message sequence. Cannot be combined with another cursor."
    })
  ),
  around_seq: Schema.optionalKey(
    Schema.Natural.annotate({
      description:
        "Transcript view only; not used with view=actions. Center one page around this transcript-search sequence. Cannot be combined with another cursor."
    })
  ),
  content_offset: Schema.optionalKey(
    Schema.Natural.annotate({
      description:
        "Skip this many characters of each message before showing content_chars; continues a cut message."
    })
  )
}).check(
  Schema.makeFilter((input) =>
    [input.after_seq, input.before_seq, input.around_seq].filter((value) => value !== undefined)
      .length <= 1
      ? undefined
      : "session_read accepts only one paging cursor"
  ),
  Schema.makeFilter((input) => {
    if (input.view === READ_VIEW.actions)
      return input.after_seq === undefined &&
        input.before_seq === undefined &&
        input.around_seq === undefined &&
        input.role_filter === undefined
        ? undefined
        : "Actions accept no transcript cursor or role filter"
    return input.before_action === undefined && input.action_turn_id === undefined
      ? undefined
      : "before_action and action_turn_id require view actions"
  })
)

export const CreateParametersSchema = Schema.Struct({
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
    Schema.annotateEncoded({
      description: "Short human-readable name for the new chat."
    })
  )
})

export const MoveParametersSchema = Schema.Struct({
  space_id: Schema.NullOr(Schema.NonEmptyString).annotate({
    description:
      "Exact space_id from space_list. Pass null to move the current chat to the Main Space."
  })
})
