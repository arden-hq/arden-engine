import {
  AGENT_RESULT_ROW,
  AUTOMATION_ROW,
  COMMUNICATION_ROW,
  CONNECTION_ROW,
  CONTEXT_BLOCK,
  CONTEXT_TEXT,
  FORWARDED_FROM,
  FROM_CHAT,
  INTERACTION_REFERENCE,
  MESSAGE_CLIENT,
  OUTPUT_PART,
  QUESTION_ANSWER_ROW,
  REASONING_ROW,
  SENT_FROM,
  STEER_STAMP,
  TEXT_PHASE,
  TOOL_CALL_STATUS,
  TOOL_DATA,
  TOOL_DURATION,
  TOOL_EXECUTION,
  UPDATE_ROW,
  toolRetry,
  type AutomationRow,
  type ForwardedFrom,
  type HistoryAssistantMessage,
  type HistoryAssistantOutputPart,
  type HistoryContextBlock,
  type HistoryImage,
  type HistoryMessage,
  type HistoryToolCall,
  type ReasoningRow,
  type ToolCallStatus,
  type ToolData
} from "@arden-hq/protocol/chat"
import {
  ChatForwardedSourceSchema,
  ChatHandoffSourceSchema,
  ChatImageSchema,
  ChatSentFromSchema,
  ChatUpdateSchema,
  CommunicationEnvelopeSchema,
  ConnectionArrivalSchema,
  QuestionAnswerSchema
} from "@arden-hq/protocol/effect/chat"
import { isAgentInstruction } from "@arden-hq/protocol/views"
import {
  INTERACTION_KIND,
  INTERACTION_OUTCOME,
  INTERACTION_SOURCE,
  ROLE
} from "@arden-hq/std/message-vocabulary"
import { DateTime, Option, Predicate, Schema } from "effect"
import { isJsonObject } from "../persistence/json.js"
import { isLegacyRestartInterruption, RESTART_INTERRUPTION } from "../persistence/restart-notice.js"
import { upgradeQuestionData } from "../persistence/runs/stored-question-data.js"
import type {
  AgentAssignment,
  ToolExecutionResultMetadata
} from "../persistence/tools/history-queries.js"
import { isChatEventsMessage } from "../persistence/transcript/chat-events.js"
import {
  StoredAgentResultSchema,
  StoredInteractionSenderSchema,
  interactionPreview,
  wireAgentResult,
  wireSender
} from "../persistence/transcript/interaction.js"
import { previewLine } from "../persistence/transcript/preview-line.js"
import type { StampedTranscriptMessageRecord } from "./history-projection.js"
import {
  historyProviderToolCalls,
  historyToolCalls,
  withConversationResult,
  withResultMetadata
} from "./history-tool-calls.js"
import { SURFACE, surfaceOfCall, surfaceOfPart, type Surface } from "./surface.js"

const ReplyContextSchema = Schema.Struct({
  messageId: Schema.NonEmptyString,
  role: Schema.Literals(["user", "assistant"] as const),
  content: Schema.String
})

const StoredReplySchema = Schema.Union([
  ReplyContextSchema,
  Schema.NonEmptyArray(ReplyContextSchema)
])

interface ProjectedMessage {
  readonly message: HistoryMessage
  readonly warnings: ReadonlyArray<string>
}

export type ChatHandoffSource = typeof ChatHandoffSourceSchema.Type

const decoded = <A>(schema: Schema.Codec<A, unknown>, value: unknown): A | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value))

const AutomationSchema = Schema.Struct({
  task_id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  prompt: Schema.NonEmptyString,
  context_mode: Schema.Literals(["fresh", "continue", "fork"] as const)
})

const automationRow = (value: unknown): AutomationRow => {
  const automation = decoded(AutomationSchema, value)
  return automation === undefined
    ? { kind: AUTOMATION_ROW.none }
    : { kind: AUTOMATION_ROW.automation, ...automation }
}

const forwardedRow = (value: unknown): ForwardedFrom => {
  const forwarded = decoded(ChatForwardedSourceSchema, value)
  return forwarded === undefined
    ? { kind: FORWARDED_FROM.original }
    : { kind: FORWARDED_FROM.forwarded, ...forwarded }
}

const toolStatus = (
  envelope: Readonly<Record<string, unknown>>,
  metadata: ToolExecutionResultMetadata | undefined
): ToolCallStatus => {
  if (metadata !== undefined)
    return {
      kind: TOOL_CALL_STATUS.settled,
      is_error: metadata.isError,
      retry: toolRetry(metadata.retryable),
      duration: { kind: TOOL_DURATION.untimed }
    }
  if (!Predicate.isBoolean(envelope.is_error)) return { kind: TOOL_CALL_STATUS.open }
  return {
    kind: TOOL_CALL_STATUS.settled,
    is_error: envelope.is_error,
    retry: toolRetry(Predicate.isBoolean(envelope.retryable) ? envelope.retryable : null),
    duration: { kind: TOOL_DURATION.untimed }
  }
}

const storedRowData = (value: unknown): ToolData =>
  isJsonObject(value)
    ? { kind: TOOL_DATA.attached, value: upgradeQuestionData(value) }
    : { kind: TOOL_DATA.none }

export const projectMessage = (
  record: StampedTranscriptMessageRecord,
  resultMetadata: ReadonlyMap<string, ToolExecutionResultMetadata>,
  surface: Surface,
  pinnedResults: ReadonlyMap<string, string>,
  parentSource: ChatHandoffSource | undefined,
  assignment: AgentAssignment | undefined
): ProjectedMessage | null => {
  if (record.role === ROLE.system || record.role === ROLE.developer) return null
  if (typeof record.envelope.forked_from === "string") return null
  if (isChatEventsMessage(record.envelope)) return null
  const envelope: Readonly<Record<string, unknown>> = record.envelope
  const contentValue = envelope.content
  const storedContent = contentText(contentValue)
  const conversation = surface === SURFACE.conversation
  const replyTo = decoded(StoredReplySchema, envelope.replyTo)
  const base = {
    message_id: record.messageId,
    turn_id: record.envelope.turn_id,
    content: conversation || record.role === ROLE.tool ? storedContent : "",
    seq: record.sequence,
    created_at: DateTime.formatIso(record.createdAt),
    client:
      record.clientId === null
        ? { kind: MESSAGE_CLIENT.untracked }
        : { kind: MESSAGE_CLIENT.tracked, client_id: record.clientId },
    applied:
      typeof envelope.applied_at === "string"
        ? { kind: STEER_STAMP.stamped, at: envelope.applied_at }
        : { kind: STEER_STAMP.unstamped },
    context: conversation ? contentContext(contentValue) : [],
    reply_to:
      replyTo === undefined
        ? []
        : ("messageId" in replyTo ? [replyTo] : replyTo).map((quoted) => ({
            message_id: quoted.messageId,
            role: quoted.role,
            content: quoted.content
          })),
    compact: envelope.compact === true
  } as const
  if (record.role === ROLE.assistant) {
    const assistant = projectAssistant(envelope, surface, resultMetadata, pinnedResults)
    return {
      message: {
        ...base,
        role: ROLE.assistant,
        content: assistant.content,
        tool_calls: assistant.tool_calls,
        output_parts: assistant.output_parts,
        reasoning: assistant.reasoning,
        automation: conversation
          ? automationRow(envelope.automation)
          : { kind: AUTOMATION_ROW.none }
      },
      warnings: assistant.warnings
    }
  }
  if (record.role === ROLE.tool) {
    const toolCallId = Predicate.isString(envelope.tool_call_id) ? envelope.tool_call_id : ""
    const metadata = resultMetadata.get(toolCallId)
    return {
      message: {
        ...base,
        role: ROLE.tool,
        tool_call_id: toolCallId,
        status: toolStatus(envelope, metadata),
        data:
          metadata?.data === undefined
            ? storedRowData(envelope.data)
            : { kind: TOOL_DATA.attached, value: metadata.data }
      },
      warnings: []
    }
  }
  if (record.role === ROLE.user) {
    const questionAnswer = decoded(QuestionAnswerSchema, envelope.question_answer)
    const sentFrom = decoded(ChatSentFromSchema, envelope.sent_from)
    return {
      message: {
        ...base,
        role: ROLE.user,
        images: contentImages(contentValue),
        question_answer:
          questionAnswer === undefined
            ? { kind: QUESTION_ANSWER_ROW.none }
            : { kind: QUESTION_ANSWER_ROW.answer, question_id: questionAnswer.question_id },
        sent_from:
          sentFrom === undefined
            ? { kind: SENT_FROM.typed }
            : { kind: SENT_FROM.surface, surface: sentFrom },
        forwarded_from: forwardedRow(envelope.forwarded_from)
      },
      warnings: []
    }
  }
  return projectInteraction(envelope, base, surface, parentSource, assignment)
}

type RowBase = Pick<
  HistoryAssistantMessage,
  | "message_id"
  | "turn_id"
  | "content"
  | "seq"
  | "created_at"
  | "client"
  | "applied"
  | "context"
  | "reply_to"
  | "compact"
>

const projectInteraction = (
  envelope: Readonly<Record<string, unknown>>,
  base: RowBase,
  surface: Surface,
  parentSource: ChatHandoffSource | undefined,
  assignment: AgentAssignment | undefined
): ProjectedMessage | null => {
  const conversation = surface === SURFACE.conversation
  const storedContent = contentText(envelope.content)
  const legacyRestart = isLegacyRestartInterruption(storedContent)
  const decodedSender = decoded(StoredInteractionSenderSchema, envelope)
  const assignmentTask =
    decodedSender?.kind === INTERACTION_KIND.assignment &&
    decodedSender.from.source === INTERACTION_SOURCE.agent &&
    decodedSender.to !== undefined &&
    decodedSender.from.id === assignment?.fromSessionRef &&
    decodedSender.to.id === assignment?.toSessionRef &&
    decodedSender.caused_by?.type === INTERACTION_REFERENCE.toolCall &&
    decodedSender.caused_by.id === assignment?.toolCallId
      ? assignment?.task
      : undefined
  if (
    conversation &&
    decodedSender?.kind === INTERACTION_KIND.assignment &&
    decodedSender.from.source === INTERACTION_SOURCE.agent &&
    decodedSender.to !== undefined &&
    assignmentTask === undefined
  )
    return null
  if (decodedSender === undefined) return null
  const sender = wireSender(
    decodedSender.kind === INTERACTION_KIND.completion && legacyRestart
      ? { ...decodedSender, outcome: INTERACTION_OUTCOME.interrupted }
      : decodedSender
  )
  const storedResult = decoded(StoredAgentResultSchema, envelope.agent_result)
  const result =
    storedResult !== undefined && legacyRestart
      ? { ...storedResult, content: RESTART_INTERRUPTION }
      : storedResult
  const communication = conversation
    ? decoded(CommunicationEnvelopeSchema, envelope.communication)
    : undefined
  const update = decoded(ChatUpdateSchema, envelope.update)
  const connection = decoded(ConnectionArrivalSchema, envelope.connection)
  const fromChat =
    decoded(ChatHandoffSourceSchema, envelope.from_chat) ??
    (isAgentInstruction(sender, parentSource?.session_ref) ? parentSource : undefined)
  return {
    message: {
      ...base,
      ...sender,
      role: ROLE.interaction,
      content: legacyRestart ? RESTART_INTERRUPTION : (assignmentTask ?? base.content),
      forwarded_from: forwardedRow(envelope.forwarded_from),
      from_chat:
        fromChat === undefined
          ? { kind: FROM_CHAT.direct }
          : { kind: FROM_CHAT.handedOver, ...fromChat },
      connection:
        connection === undefined
          ? { kind: CONNECTION_ROW.none }
          : { kind: CONNECTION_ROW.answered, arrival: connection },
      communication:
        communication === undefined
          ? { kind: COMMUNICATION_ROW.none }
          : { kind: COMMUNICATION_ROW.letter, envelope: communication },
      update:
        update === undefined ? { kind: UPDATE_ROW.none } : { kind: UPDATE_ROW.update, update },
      agent_result:
        result === undefined
          ? { kind: AGENT_RESULT_ROW.none }
          : {
              kind: AGENT_RESULT_ROW.report,
              result: {
                ...wireAgentResult(result),
                preview: interactionPreview(previewLine(result.content) ?? result.preview)
              }
            },
      automation: conversation ? automationRow(envelope.automation) : { kind: AUTOMATION_ROW.none }
    },
    warnings:
      conversation && envelope.communication !== undefined && communication === undefined
        ? ["communication envelope is invalid; dropped"]
        : []
  }
}

const conversationPartsAfterReconciliation = (
  surface: Surface,
  parts: ReadonlyArray<HistoryAssistantOutputPart>,
  textReconciled: boolean,
  storedContent: string
): ReadonlyArray<HistoryAssistantOutputPart> => {
  if (surface === SURFACE.work || textReconciled) return parts
  if (storedContent.length === 0) return parts.filter((part) => part.type !== OUTPUT_PART.text)
  return []
}

interface AssistantSurfaceProjection {
  readonly content: string
  readonly tool_calls: ReadonlyArray<HistoryToolCall>
  readonly reasoning: ReasoningRow
  readonly output_parts: ReadonlyArray<HistoryAssistantOutputPart>
  readonly warnings: ReadonlyArray<string>
}

const projectAssistant = (
  envelope: Readonly<Record<string, unknown>>,
  surface: Surface,
  resultMetadata: ReadonlyMap<string, ToolExecutionResultMetadata>,
  pinnedResults: ReadonlyMap<string, string>
): AssistantSurfaceProjection => {
  const storedContent = contentText(envelope.content)
  const runtimeCalls = historyToolCalls(envelope.tool_calls).map((call) =>
    withResultMetadata(call, resultMetadata.get(call.id))
  )
  const providerCalls = historyProviderToolCalls(envelope.provider_tool_calls)
  const callsById = new Map(runtimeCalls.map((call) => [call.id, call]))
  const providerIds = new Set(providerCalls.map((call) => call.id))
  const warnings: Array<string> = []

  const decoded = Array.isArray(envelope.output_parts)
    ? envelope.output_parts.flatMap(
        (part, sourceIndex): ReadonlyArray<HistoryAssistantOutputPart> => {
          if (!Predicate.isObject(part)) return []
          if (
            part.type === OUTPUT_PART.text &&
            Predicate.isString(part.text) &&
            part.text.length > 0
          ) {
            const phase =
              part.phase === TEXT_PHASE.commentary || part.phase === TEXT_PHASE.finalAnswer
                ? part.phase
                : TEXT_PHASE.unmarked
            return [{ type: "text", text: part.text, phase, source_index: sourceIndex }]
          }
          if (
            part.type === OUTPUT_PART.reasoning &&
            Predicate.isString(part.text) &&
            part.text.length > 0
          ) {
            return [{ type: "reasoning", text: part.text, source_index: sourceIndex }]
          }
          if (
            part.type === OUTPUT_PART.toolCall &&
            Predicate.isString(part.tool_call_id) &&
            (part.execution === TOOL_EXECUTION.runtime ||
              part.execution === TOOL_EXECUTION.provider)
          ) {
            const known =
              part.execution === TOOL_EXECUTION.runtime
                ? callsById.has(part.tool_call_id)
                : providerIds.has(part.tool_call_id)
            if (!known) {
              warnings.push(
                `output_parts[${sourceIndex}] names unknown ${part.execution} tool call ${part.tool_call_id}; dropped`
              )
              return []
            }
            return [
              {
                type: "tool_call",
                tool_call_id: part.tool_call_id,
                execution: part.execution,
                source_index: sourceIndex
              }
            ]
          }
          return []
        }
      )
    : undefined

  const textJoin =
    decoded === undefined
      ? storedContent
      : decoded.flatMap((part) => (part.type === OUTPUT_PART.text ? [part.text] : [])).join("")
  const textReconciled = textJoin === storedContent
  if (decoded !== undefined && !textReconciled) {
    warnings.push(
      `output_parts text (${textJoin.length} chars) does not cover content (${storedContent.length} chars); text parts dropped`
    )
  }
  const surfaceParts = (decoded ?? []).filter((part) => surfaceOfPart(part, callsById) === surface)
  const outputParts = conversationPartsAfterReconciliation(
    surface,
    surfaceParts,
    textReconciled,
    storedContent
  )
  const toolCalls = [...providerCalls, ...runtimeCalls]
    .filter((call) => surfaceOfCall(call, call.execution) === surface)
    .map((call) =>
      surface === SURFACE.work
        ? call
        : withConversationResult(call, pinnedResults.get(call.id), resultMetadata.get(call.id))
    )
  const reasoning =
    Predicate.isString(envelope.reasoning_content) && envelope.reasoning_content.length > 0
      ? envelope.reasoning_content
      : undefined
  return {
    content: surface === SURFACE.conversation ? storedContent : "",
    tool_calls: toolCalls,
    reasoning:
      surface === SURFACE.work && reasoning !== undefined
        ? { kind: REASONING_ROW.reasoned, text: reasoning }
        : { kind: REASONING_ROW.none },
    output_parts: outputParts,
    warnings
  }
}

export const contentText = (value: unknown): string => {
  if (Predicate.isString(value)) return value
  if (!Array.isArray(value)) return ""
  return value
    .filter(Predicate.isObject)
    .flatMap((block) => (Predicate.isString(block.text) ? [block.text] : []))
    .join("\n\n")
}

const decodeHistoryImage = Schema.decodeUnknownOption(ChatImageSchema)

const contentImages = (value: unknown): ReadonlyArray<HistoryImage> => {
  if (!Array.isArray(value)) return []
  return value.flatMap((block) => {
    const decoded = decodeHistoryImage(block)
    return Option.isSome(decoded) ? [decoded.value] : []
  })
}

const contentContext = (value: unknown): ReadonlyArray<HistoryContextBlock> => {
  if (!Array.isArray(value)) return []
  return value.filter(Predicate.isObject).flatMap((block) => {
    if (block.type !== CONTEXT_BLOCK || !Predicate.isString(block.content_type)) return []
    const metadata = Predicate.isObject(block.metadata)
      ? Object.fromEntries(
          Object.entries(block.metadata).filter((entry): entry is [string, string] =>
            Predicate.isString(entry[1])
          )
        )
      : {}
    return [
      {
        type: "context" as const,
        content_type: block.content_type,
        content: Predicate.isString(block.content)
          ? { kind: CONTEXT_TEXT.text, text: block.content }
          : { kind: CONTEXT_TEXT.empty },
        metadata
      }
    ]
  })
}
