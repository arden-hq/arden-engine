import { Schema } from "effect"
import { withExtras } from "../common/schema.js"
import { APPROVAL_MODES } from "../permissions/modes.js"
import {
  ANSWER_SHAPE,
  APPROVAL_REPLY,
  APPROVED_AS,
  ARGUMENT_EDITS,
  CANCEL_TARGET,
  CHAT_CAPTURE,
  CHAT_REPLY_QUOTES_MAX,
  CONNECTION_RESULT,
  DECISION_ASKED,
  FOLDER_ATTACH,
  GRANT_LIST,
  RELAY_COMMAND,
  REQUESTED_MODE,
  STANDING_GRANT,
  TOOL_DECISION
} from "./contracts.js"
import { SENT_FROM } from "./history-message.js"
import {
  ChatCaptureViaSchema,
  ChatImageSchema,
  ChatSentFromSchema,
  ReplyContextSchema
} from "./history-message-schema.js"

const tagged = <const Tag extends string>(kind: Tag) =>
  Schema.Struct({ kind: Schema.Literal(kind) })

const JsonObject = Schema.Record(Schema.String, Schema.Json)

export const SentFromSchema = Schema.Union([
  tagged(SENT_FROM.typed),
  Schema.Struct({ kind: Schema.Literal(SENT_FROM.surface), surface: ChatSentFromSchema })
])

export const RequestedApprovalModeSchema = Schema.Union([
  tagged(REQUESTED_MODE.current),
  Schema.Struct({
    kind: Schema.Literal(REQUESTED_MODE.mode),
    mode: Schema.Literals(APPROVAL_MODES)
  })
])

export const ChatCaptureSchema = Schema.Union([
  tagged(CHAT_CAPTURE.none),
  Schema.Struct({ kind: Schema.Literal(CHAT_CAPTURE.capture), via: ChatCaptureViaSchema })
])

export const AnswerShapeSchema = Schema.Union([
  tagged(ANSWER_SHAPE.free),
  Schema.Struct({ kind: Schema.Literal(ANSWER_SHAPE.schema), schema: JsonObject })
])

const StandingGrantSchema = Schema.Union([
  tagged(STANDING_GRANT.once),
  Schema.Struct({
    kind: Schema.Literal(STANDING_GRANT.standing),
    list: Schema.Literals([GRANT_LIST.cardDefault, GRANT_LIST.space, GRANT_LIST.global])
  })
])

export const ToolDecisionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(TOOL_DECISION.unstated), grant: StandingGrantSchema }),
  Schema.Struct({ kind: Schema.Literal(TOOL_DECISION.denied), grant: StandingGrantSchema }),
  Schema.Struct({
    kind: Schema.Literal(TOOL_DECISION.approved),
    grant: StandingGrantSchema,
    folder: Schema.Literals([FOLDER_ATTACH.keep, FOLDER_ATTACH.attach]),
    edits: Schema.Union([
      tagged(ARGUMENT_EDITS.asAsked),
      Schema.Struct({ kind: Schema.Literal(ARGUMENT_EDITS.edited), arguments: JsonObject })
    ]),
    as: Schema.Literals([APPROVED_AS.asAsked, APPROVED_AS.draft])
  })
]).check(
  Schema.makeFilter((decision) =>
    decision.kind === TOOL_DECISION.approved &&
    decision.folder === FOLDER_ATTACH.attach &&
    decision.grant.kind === STANDING_GRANT.standing
      ? { path: ["folder"], issue: "cannot be combined with a standing grant" }
      : undefined
  )
)

export const DecisionAskedSchema = Schema.Union([
  tagged(DECISION_ASKED.unstated),
  Schema.Struct({ kind: Schema.Literal(DECISION_ASKED.at), at: Schema.NonEmptyString })
])

export const RelayCommandSchema = Schema.Union([
  tagged(RELAY_COMMAND.none),
  Schema.Struct({ kind: Schema.Literal(RELAY_COMMAND.command), id: Schema.NonEmptyString })
])

export const ConnectionResultTextSchema = Schema.Union([
  tagged(CONNECTION_RESULT.cardDefault),
  Schema.Struct({ kind: Schema.Literal(CONNECTION_RESULT.stated), text: Schema.String })
])

const hasContent = Schema.makeFilter(
  (request: { readonly message: string; readonly images: ReadonlyArray<unknown> }) =>
    request.message.trim().length > 0 || request.images.length > 0
      ? undefined
      : { path: ["message"], issue: "message or images must contain content" }
)

export const ChatRequestSchema = withExtras({
  session_id: Schema.NonEmptyString,
  client_id: Schema.NonEmptyString,
  message: Schema.String,
  images: Schema.Array(ChatImageSchema),
  reply_to: Schema.Array(ReplyContextSchema).check(Schema.isMaxLength(CHAT_REPLY_QUOTES_MAX)),
  approval_reply: Schema.Union([
    tagged(APPROVAL_REPLY.none),
    Schema.Struct({
      kind: Schema.Literal(APPROVAL_REPLY.deny),
      run_id: Schema.NonEmptyString,
      tool_id: Schema.NonEmptyString
    })
  ]),
  approval_mode: RequestedApprovalModeSchema,
  sent_from: SentFromSchema,
  capture: ChatCaptureSchema,
  output_schema: AnswerShapeSchema
}).check(hasContent)

export const ToolResultRequestSchema = withExtras({
  run_id: Schema.String,
  tool_id: Schema.String,
  result: Schema.String,
  decision: ToolDecisionSchema,
  asked: DecisionAskedSchema,
  command: RelayCommandSchema
})

export const ConnectionResultRequestSchema = withExtras({
  run_id: Schema.String,
  tool_id: Schema.String,
  connection_id: Schema.String,
  result: ConnectionResultTextSchema,
  approved: Schema.Boolean
})

export const CancelRequestSchema = Schema.Union([
  withExtras({ kind: Schema.Literal(CANCEL_TARGET.run), run_id: Schema.NonEmptyString }),
  withExtras({
    kind: Schema.Literal(CANCEL_TARGET.session),
    session_id: Schema.NonEmptyString,
    hold_queue: Schema.Boolean
  })
])
