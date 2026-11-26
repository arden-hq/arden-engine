import { Schema } from "effect"
import { NonNegativeIntSchema, withExtras } from "../common/schema.js"
import { CHAT_REPLY_QUOTES_MAX } from "./contracts.js"
import { ChatUpdateSchema, CommunicationEnvelopeSchema } from "./communication-schema.js"
import { CONTEXT_LIMIT, CONTEXT_MODEL, type ContextBudgetSnapshot } from "./history.js"
import {
  AGENT_RESULT_ROW,
  AUTOMATION_ROW,
  COMMUNICATION_ROW,
  CONNECTION_ROW,
  CONTEXT_TEXT,
  FORWARDED_FROM,
  FROM_CHAT,
  MESSAGE_CLIENT,
  QUESTION_ANSWER_ROW,
  REASONING_ROW,
  SENT_FROM,
  STEER_STAMP,
  TEXT_PHASE,
  UPDATE_ROW,
  type HistoryMessage
} from "./history-message.js"
import { HistoryToolCallSchema, ToolCallStatusSchema } from "./history-tool-call.js"
import { AgentResultSchema, interactionSenderFields } from "./interaction.js"
import {
  chatIdentifier,
  chatMessage,
  ImageDataSchema,
  ImageMediaTypeSchema,
  ServedImageDataSchema
} from "./schema-fields.js"
import { ToolDataSchema } from "./tool-face.js"

const tagged = <const Tag extends string>(kind: Tag) =>
  Schema.Struct({ kind: Schema.Literal(kind) })

export const ContextBlockSchema = withExtras({
  type: Schema.Literal("context"),
  content_type: Schema.String,
  content: Schema.Union([
    tagged(CONTEXT_TEXT.empty),
    Schema.Struct({ kind: Schema.Literal(CONTEXT_TEXT.text), text: Schema.String })
  ]),
  metadata: Schema.Record(Schema.String, Schema.String)
})

export const ChatHandoffSourceSchema = Schema.Struct({
  session_id: Schema.NonEmptyString,
  session_ref: Schema.NonEmptyString
})

export const ChatForwardedSourceSchema = Schema.Struct({
  ...ChatHandoffSourceSchema.fields,
  message_id: Schema.NonEmptyString
})

export const ChatSentFromSchema = Schema.Literals(["visualization", "answer", "cli"] as const)

export const ConnectionArrivalSchema = Schema.Struct({
  tool_call_id: Schema.NonEmptyString,
  server: Schema.NonEmptyString,
  outcome: Schema.Literals(["connected", "declined"] as const),
  offered_at: Schema.NonEmptyString,
  at: Schema.NonEmptyString
})

export const ChatCaptureViaSchema = Schema.Literals(["quick", "phone"] as const)

export const ReplyContextSchema = Schema.Struct({
  message_id: chatIdentifier,
  role: Schema.Literals(["user", "assistant"] as const),
  content: chatMessage
})

export const ReplyContextsSchema = Schema.Union([
  ReplyContextSchema,
  Schema.NonEmptyArray(ReplyContextSchema).check(Schema.isMaxLength(CHAT_REPLY_QUOTES_MAX))
])

export const ChatImageSchema = Schema.Struct({
  type: Schema.Literal("image"),
  media_type: ImageMediaTypeSchema,
  data: ImageDataSchema
})

const HistoryImageSchema = Schema.Struct({
  type: Schema.Literal("image"),
  media_type: ImageMediaTypeSchema,
  data: ServedImageDataSchema
})

const historyAssistantOutputPartSchema = Schema.Union([
  withExtras({
    type: Schema.Literal("reasoning"),
    text: Schema.NonEmptyString,
    source_index: NonNegativeIntSchema
  }),
  withExtras({
    type: Schema.Literal("text"),
    text: Schema.NonEmptyString,
    phase: Schema.Literals([TEXT_PHASE.unmarked, TEXT_PHASE.commentary, TEXT_PHASE.finalAnswer]),
    source_index: NonNegativeIntSchema
  }),
  withExtras({
    type: Schema.Literal("tool_call"),
    tool_call_id: Schema.NonEmptyString,
    execution: Schema.Literals(["runtime", "provider"] as const),
    source_index: NonNegativeIntSchema
  })
])

const ForwardedFromSchema = Schema.Union([
  tagged(FORWARDED_FROM.original),
  Schema.Struct({
    kind: Schema.Literal(FORWARDED_FROM.forwarded),
    ...ChatForwardedSourceSchema.fields
  })
])

const AutomationRowSchema = Schema.Union([
  tagged(AUTOMATION_ROW.none),
  Schema.Struct({
    kind: Schema.Literal(AUTOMATION_ROW.automation),
    task_id: Schema.NonEmptyString,
    name: Schema.NonEmptyString,
    prompt: Schema.NonEmptyString,
    context_mode: Schema.Literals(["fresh", "continue", "fork"] as const)
  })
])

const baseFields = {
  message_id: Schema.String,
  turn_id: Schema.NonEmptyString,
  content: Schema.String,
  seq: Schema.Int,
  created_at: Schema.String,
  client: Schema.Union([
    tagged(MESSAGE_CLIENT.untracked),
    Schema.Struct({ kind: Schema.Literal(MESSAGE_CLIENT.tracked), client_id: Schema.String })
  ]),
  applied: Schema.Union([
    tagged(STEER_STAMP.unstamped),
    Schema.Struct({ kind: Schema.Literal(STEER_STAMP.stamped), at: Schema.String })
  ]),
  context: Schema.Array(ContextBlockSchema),
  reply_to: Schema.Array(ReplyContextSchema),
  compact: Schema.Boolean
}

const interactionFields = {
  ...baseFields,
  role: Schema.Literal("interaction"),
  forwarded_from: ForwardedFromSchema,
  from_chat: Schema.Union([
    tagged(FROM_CHAT.direct),
    Schema.Struct({
      kind: Schema.Literal(FROM_CHAT.handedOver),
      ...ChatHandoffSourceSchema.fields
    })
  ]),
  connection: Schema.Union([
    tagged(CONNECTION_ROW.none),
    Schema.Struct({
      kind: Schema.Literal(CONNECTION_ROW.answered),
      arrival: ConnectionArrivalSchema
    })
  ]),
  communication: Schema.Union([
    tagged(COMMUNICATION_ROW.none),
    Schema.Struct({
      kind: Schema.Literal(COMMUNICATION_ROW.letter),
      envelope: CommunicationEnvelopeSchema
    })
  ]),
  update: Schema.Union([
    tagged(UPDATE_ROW.none),
    Schema.Struct({ kind: Schema.Literal(UPDATE_ROW.update), update: ChatUpdateSchema })
  ]),
  agent_result: Schema.Union([
    tagged(AGENT_RESULT_ROW.none),
    Schema.Struct({ kind: Schema.Literal(AGENT_RESULT_ROW.report), result: AgentResultSchema })
  ]),
  automation: AutomationRowSchema
}

export const HistoryMessageSchema: Schema.Codec<HistoryMessage> = Schema.Union([
  withExtras({
    ...baseFields,
    role: Schema.Literal("user"),
    images: Schema.Array(HistoryImageSchema),
    question_answer: Schema.Union([
      tagged(QUESTION_ANSWER_ROW.none),
      Schema.Struct({
        kind: Schema.Literal(QUESTION_ANSWER_ROW.answer),
        question_id: Schema.NonEmptyString
      })
    ]),
    sent_from: Schema.Union([
      tagged(SENT_FROM.typed),
      Schema.Struct({ kind: Schema.Literal(SENT_FROM.surface), surface: ChatSentFromSchema })
    ]),
    forwarded_from: ForwardedFromSchema
  }),
  withExtras({ ...interactionFields, ...interactionSenderFields[0] }),
  withExtras({ ...interactionFields, ...interactionSenderFields[1] }),
  withExtras({
    ...baseFields,
    role: Schema.Literal("assistant"),
    tool_calls: Schema.Array(HistoryToolCallSchema),
    output_parts: Schema.Array(historyAssistantOutputPartSchema),
    reasoning: Schema.Union([
      tagged(REASONING_ROW.none),
      Schema.Struct({ kind: Schema.Literal(REASONING_ROW.reasoned), text: Schema.String })
    ]),
    automation: AutomationRowSchema
  }),
  withExtras({
    ...baseFields,
    role: Schema.Literal("tool"),
    tool_call_id: Schema.String,
    status: ToolCallStatusSchema,
    data: ToolDataSchema
  })
])

export const ContextBudgetSnapshotSchema: Schema.Codec<ContextBudgetSnapshot> = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(CONTEXT_LIMIT.unresolved),
    model: Schema.Union([
      tagged(CONTEXT_MODEL.unselected),
      Schema.Struct({ kind: Schema.Literal(CONTEXT_MODEL.selected), model_id: Schema.String })
    ]),
    input_tokens: Schema.Int,
    message_count: Schema.Int
  }),
  Schema.Struct({
    kind: Schema.Literal(CONTEXT_LIMIT.resolved),
    model: Schema.String,
    hard_limit: Schema.Int,
    compaction_trigger: Schema.Int,
    input_tokens: Schema.Int,
    message_count: Schema.Int
  })
])
