import { cutText } from "@arden-hq/std/text"
import { TRANSCRIPT_RESULT_PREVIEW_CHARS } from "../persistence/transcript/model.js"
import { previewLine } from "../persistence/transcript/preview-line.js"
import { isChatEventsMessage } from "../persistence/transcript/chat-events.js"
import { isLegacyRestartInterruption, RESTART_INTERRUPTION } from "../persistence/restart-notice.js"
import {
  TOOL_DISPLAY_TITLE_ARGUMENT,
  type HistoryAssistantOutputPart,
  type HistoryResponse,
  type HistoryMessage,
  type TurnWorkResponse
} from "@arden-hq/protocol/chat"
import { ToolOutcomeSchema } from "@arden-hq/protocol/effect/common"
import { SkillNameSchema } from "@arden-hq/protocol/effect/skills"
import {
  AgentResultSchema,
  ChatHandoffSourceSchema,
  ChatForwardedSourceSchema,
  ChatImageSchema,
  ChatSentFromSchema,
  ChatUpdateSchema,
  CommunicationEnvelopeSchema,
  ConnectionArrivalSchema,
  GmailSendReceiptSchema,
  InteractionSchema,
  QuestionAnswerSchema
} from "@arden-hq/protocol/effect/chat"
import type { Interaction } from "@arden-hq/loop"
import type { Agrees, Assert } from "@arden-hq/protocol/common"
import { DateTime, Effect, Option, Predicate, Schema } from "effect"
import type { ChatRunRecord } from "../persistence/runs/model.js"
import type { TranscriptMessageRecord, TranscriptPage } from "../persistence/transcript/model.js"
import type {
  AgentAssignment,
  ToolExecutionResultMetadata
} from "../persistence/tools/history-queries.js"
import { ChatHistoryError } from "./history-errors.js"
import { conversationCall, surfaceOfCall, surfaceOfPart, type Surface } from "./surface.js"
import { isAgentInstruction } from "@arden-hq/protocol/views"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"

/** @internal */
export type InteractionAgrees = Assert<Agrees<(typeof InteractionSchema)["Type"], Interaction>>

const ReplyContextSchema = Schema.Struct({
  messageId: Schema.NonEmptyString,
  role: Schema.Literals(["user", "assistant"] as const),
  content: Schema.String
})

/** A stored reply quotes one message (every row before multi-quote) or a list. */
const StoredReplySchema = Schema.Union([
  ReplyContextSchema,
  Schema.NonEmptyArray(ReplyContextSchema)
])

export const emptyHistory = (budget: HistoryResponse["context_budget"]): HistoryResponse => ({
  messages: [],
  active_work_tail: null,
  runtime: {
    session_id: null,
    latest_event_seq: 0,
    checkpoint_seq: 0,
    active_run: null,
    blocking_work: false,
    pending_approvals: [],
    pending_connections: []
  },
  page: { has_more_before: false, has_more_after: false, before: null, after: null },
  context_budget: budget
})

export const historyPage = (page: TranscriptPage): HistoryResponse["page"] => ({
  has_more_before: page.hasMoreBefore,
  has_more_after: page.hasMoreAfter,
  before: page.records[0]?.messageId ?? null,
  after: page.records[page.records.length - 1]?.messageId ?? null
})

export const activeRunSnapshot = (
  run: ChatRunRecord | null,
  latestEventSequence: number,
  checkpointSequence: number,
  pendingApprovals: HistoryResponse["runtime"]["pending_approvals"],
  pendingConnections: HistoryResponse["runtime"]["pending_connections"],
  waitingToolCallIds: ReadonlyArray<string>
): HistoryResponse["runtime"]["active_run"] => {
  if (run === null || !isActiveRunStatus(run.status)) return null
  return {
    run_id: run.runId,
    turn_id: run.turnId,
    status: run.status,
    started_at: DateTime.formatIso(run.startedAt),
    updated_at: DateTime.formatIso(run.updatedAt),
    ended_at: null,
    stop_reason: null,
    checkpoint_seq: checkpointSequence,
    latest_event_seq: run.lastSequence ?? latestEventSequence,
    error_code: null,
    error_message: null,
    pending_approvals: pendingApprovals.filter((approval) => approval.run_id === run.runId),
    pending_connections: pendingConnections.filter((connection) => connection.run_id === run.runId),
    waiting_tool_call_ids: [...waitingToolCallIds]
  }
}

export type StampedTranscriptMessageRecord = TranscriptMessageRecord & {
  readonly envelope: TranscriptMessageRecord["envelope"] & { readonly turn_id: string }
}

const hasTurnStamp = (record: TranscriptMessageRecord): record is StampedTranscriptMessageRecord =>
  Predicate.isString(record.envelope.turn_id) && record.envelope.turn_id.length > 0

export const requireTurnStamps = Effect.fn("ChatHistory.requireTurnStamps")(function* (
  records: ReadonlyArray<TranscriptMessageRecord>,
  sessionId: string
): Effect.fn.Return<ReadonlyArray<StampedTranscriptMessageRecord>, ChatHistoryError> {
  const stamped = records.filter(hasTurnStamp)
  if (stamped.length !== records.length) {
    return yield* new ChatHistoryError({
      message: `Transcript rows for ${sessionId} are missing durable turn identity`
    })
  }
  return stamped
})

export const pinnedConversationCalls = (
  records: ReadonlyArray<StampedTranscriptMessageRecord>
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const pinnedByTurn = new Map<string, Array<string>>()
  for (const record of records) {
    if (record.role !== "assistant") continue
    const ids = historyToolCalls(record.envelope.tool_calls)
      .filter(conversationCall)
      .map((call) => call.id)
    if (ids.length === 0) continue
    pinnedByTurn.set(record.envelope.turn_id, [
      ...(pinnedByTurn.get(record.envelope.turn_id) ?? []),
      ...ids
    ])
  }
  return pinnedByTurn
}

export const toolResultTexts = (
  results: ReadonlyArray<TranscriptMessageRecord>
): ReadonlyMap<string, string> => {
  const texts = new Map<string, string>()
  for (const result of results) {
    const toolCallId = result.envelope.tool_call_id
    if (Predicate.isString(toolCallId)) texts.set(toolCallId, contentText(result.envelope.content))
  }
  return texts
}

export const isConversationRecord = (record: TranscriptMessageRecord): boolean =>
  record.role !== "system" &&
  record.role !== "developer" &&
  !isSessionHandoff(record.envelope) &&
  typeof record.envelope.forked_from !== "string"

export const mergeTurnWorkRecords = (
  carriers: ReadonlyArray<StampedTranscriptMessageRecord>,
  results: ReadonlyArray<StampedTranscriptMessageRecord>
): ReadonlyArray<StampedTranscriptMessageRecord> => {
  const byId = new Map<string, StampedTranscriptMessageRecord>()
  for (const record of [...carriers, ...results]) byId.set(record.messageId, record)
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence)
}

const COMPACT_TEXT_CHARS = TRANSCRIPT_RESULT_PREVIEW_CHARS

const compactText = (text: string): string => cutText(text, COMPACT_TEXT_CHARS)

const compactArguments = (raw: string): { readonly text: string; readonly changed: boolean } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (!Predicate.isObject(parsed) || Array.isArray(parsed)) {
    return raw.length <= COMPACT_TEXT_CHARS
      ? { text: raw, changed: false }
      : { text: compactText(raw), changed: true }
  }
  let changed = false
  const compact: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (Predicate.isString(value)) {
      if (key === TOOL_DISPLAY_TITLE_ARGUMENT || value.length <= COMPACT_TEXT_CHARS)
        compact[key] = value
      else {
        compact[key] = compactText(value)
        changed = true
      }
    } else if (value === null || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
      compact[key] = value
    } else {
      const json = JSON.stringify(value)
      if (json.length <= COMPACT_TEXT_CHARS) compact[key] = value
      else changed = true
    }
  }
  return { text: changed ? JSON.stringify(compact) : raw, changed }
}

export const compactTurnWork = (response: TurnWorkResponse): TurnWorkResponse => ({
  ...response,
  messages: response.messages.map((message) => {
    if (message.role === "tool") {
      const content = compactText(message.content)
      return content === message.content ? message : { ...message, content, compact: true }
    }
    if (message.role !== "assistant" || message.tool_calls === undefined) return message
    let changed = false
    const toolCalls = message.tool_calls.map((call) => {
      const compacted = compactArguments(call.arguments)
      const result = call.result === undefined ? undefined : compactText(call.result)
      if (!compacted.changed && result === call.result) return call
      changed = true
      return {
        ...call,
        arguments: compacted.text,
        ...(result === undefined ? {} : { result })
      }
    })
    return changed ? { ...message, tool_calls: toolCalls, compact: true } : message
  })
})

export const projectMessages = Effect.fn("ChatHistory.projectMessages")(function* (
  records: ReadonlyArray<StampedTranscriptMessageRecord>,
  resultMetadata: ReadonlyMap<string, ToolExecutionResultMetadata>,
  surface: Surface,
  options: {
    readonly pinnedResults?: ReadonlyMap<string, string>
    readonly parentSource?: HistoryMessage["from_chat"]
    readonly assignment?: AgentAssignment | undefined
  } = {}
): Effect.fn.Return<HistoryResponse["messages"], never> {
  const messages: Array<HistoryResponse["messages"][number]> = []
  for (const record of records) {
    const projected = projectMessage(
      record,
      resultMetadata,
      surface,
      options.pinnedResults,
      options.parentSource,
      options.assignment
    )
    if (projected === null) continue
    for (const warning of projected.warnings) {
      yield* Effect.logWarning(warning, {
        sessionId: record.sessionId,
        messageId: record.messageId,
        surface
      })
    }
    messages.push(projected.message)
  }
  return messages
})

interface ProjectedMessage {
  readonly message: HistoryResponse["messages"][number]
  readonly warnings: ReadonlyArray<string>
}

const projectMessage = (
  record: StampedTranscriptMessageRecord,
  resultMetadata: ReadonlyMap<string, ToolExecutionResultMetadata>,
  surface: Surface,
  pinnedResults: ReadonlyMap<string, string> = new Map(),
  parentSource?: HistoryMessage["from_chat"],
  assignment?: AgentAssignment
): ProjectedMessage | null => {
  if (record.role === "system" || record.role === "developer") return null
  if (typeof record.envelope.forked_from === "string") return null
  if (isChatEventsMessage(record.envelope)) return null
  const envelope: Readonly<Record<string, unknown>> = record.envelope
  const contentValue = envelope.content
  const storedContent = contentText(contentValue)
  const assistant =
    record.role === "assistant"
      ? projectAssistant(envelope, surface, resultMetadata, pinnedResults)
      : null
  const keepsStoredContent = surface === "conversation" || record.role === "tool"
  const content = assistant?.content ?? (keepsStoredContent ? storedContent : "")
  const context = surface === "conversation" ? contentContext(contentValue) : []
  const toolCallId =
    record.role === "tool" && Predicate.isString(envelope.tool_call_id)
      ? envelope.tool_call_id
      : undefined
  const metadata = toolCallId === undefined ? undefined : resultMetadata.get(toolCallId)
  const persistedIsError = Predicate.isBoolean(envelope.is_error) ? envelope.is_error : undefined
  const isError = record.role === "tool" ? (metadata?.isError ?? persistedIsError) : undefined
  const persistedRetryable =
    record.role === "tool" &&
    (envelope.retryable === null || Predicate.isBoolean(envelope.retryable))
      ? envelope.retryable
      : undefined
  const retryable = metadata === undefined ? persistedRetryable : metadata.retryable
  const outcome =
    record.role === "tool" ? Option.getOrUndefined(decodeToolOutcome(envelope.outcome)) : undefined
  const data = metadata?.data ?? envelope.data
  const automation =
    surface === "conversation" && (record.role === "user" || record.role === "assistant")
      ? Option.getOrUndefined(
          Schema.decodeUnknownOption(
            Schema.Struct({
              task_id: Schema.NonEmptyString,
              name: Schema.NonEmptyString,
              prompt: Schema.NonEmptyString,
              context_mode: Schema.Literals(["fresh", "continue", "fork"] as const)
            })
          )(envelope.automation)
        )
      : undefined
  const communication =
    surface === "conversation" && record.role === "user"
      ? Option.getOrUndefined(
          Schema.decodeUnknownOption(CommunicationEnvelopeSchema)(envelope.communication)
        )
      : undefined
  const update =
    record.role === "user"
      ? Option.getOrUndefined(Schema.decodeUnknownOption(ChatUpdateSchema)(envelope.update))
      : undefined
  const legacyRestart = record.role === "user" && isLegacyRestartInterruption(storedContent)
  const decodedResult = Option.getOrUndefined(
    Schema.decodeUnknownOption(AgentResultSchema)(envelope.agent_result)
  )
  const storedResult =
    decodedResult !== undefined && legacyRestart
      ? { ...decodedResult, content: RESTART_INTERRUPTION }
      : decodedResult
  const resultPreview = storedResult === undefined ? null : previewLine(storedResult.content)
  let agentResult = storedResult
  if (storedResult !== undefined && resultPreview !== null) {
    agentResult = { ...storedResult, preview: resultPreview }
  }
  const decodedInteraction = Option.getOrUndefined(
    Schema.decodeUnknownOption(InteractionSchema)(envelope.interaction)
  )
  const assignmentTask =
    record.role === "user" &&
    decodedInteraction?.kind === "assignment" &&
    decodedInteraction.from.type === "agent" &&
    decodedInteraction.to.type === "agent" &&
    decodedInteraction.from.id === assignment?.fromSessionRef &&
    decodedInteraction.to.id === assignment?.toSessionRef &&
    decodedInteraction.causedBy?.type === "tool_call" &&
    decodedInteraction.causedBy.id === assignment?.toolCallId
      ? assignment?.task
      : undefined
  if (
    surface === "conversation" &&
    record.role === "user" &&
    decodedInteraction?.kind === "assignment" &&
    decodedInteraction.from.type === "agent" &&
    decodedInteraction.to.type === "agent" &&
    assignmentTask === undefined
  )
    return null
  const interaction =
    decodedInteraction === undefined
      ? undefined
      : {
          ...decodedInteraction,
          ...(decodedInteraction.kind === "completion" && legacyRestart
            ? { outcome: "interrupted" as const, content: RESTART_INTERRUPTION }
            : {}),
          ...(assignmentTask === undefined ? {} : { content: assignmentTask })
        }
  const replyTo = Option.getOrUndefined(
    Schema.decodeUnknownOption(StoredReplySchema)(envelope.replyTo)
  )
  const recipe =
    record.role === "user"
      ? Option.getOrUndefined(Schema.decodeUnknownOption(SkillNameSchema)(envelope.recipe))
      : undefined
  const questionAnswer =
    record.role === "user"
      ? Option.getOrUndefined(
          Schema.decodeUnknownOption(QuestionAnswerSchema)(envelope.question_answer)
        )
      : undefined
  const connection =
    record.role === "user"
      ? Option.getOrUndefined(
          Schema.decodeUnknownOption(ConnectionArrivalSchema)(envelope.connection)
        )
      : undefined
  const fromChat =
    record.role === "user"
      ? (Option.getOrUndefined(
          Schema.decodeUnknownOption(ChatHandoffSourceSchema)(envelope.from_chat)
        ) ??
        (isAgentInstruction(interaction, { parentSessionRef: parentSource?.session_ref })
          ? parentSource
          : undefined))
      : undefined
  const forwardedFrom =
    record.role === "user"
      ? Option.getOrUndefined(
          Schema.decodeUnknownOption(ChatForwardedSourceSchema)(envelope.forwarded_from)
        )
      : undefined
  const sentFrom =
    record.role === "user"
      ? Option.getOrUndefined(Schema.decodeUnknownOption(ChatSentFromSchema)(envelope.sent_from))
      : undefined
  const projected = {
    content: legacyRestart ? RESTART_INTERRUPTION : (assignmentTask ?? content),
    message_id: record.messageId,
    ...(record.clientId === null ? {} : { client_id: record.clientId }),
    seq: record.sequence,
    created_at: DateTime.formatIso(record.createdAt),
    ...(typeof envelope.applied_at === "string" ? { applied_at: envelope.applied_at } : {}),
    ...(context.length === 0 ? {} : { context }),
    ...(assistant === null || assistant.tool_calls.length === 0
      ? {}
      : { tool_calls: assistant.tool_calls }),
    ...(assistant?.reasoning_content === undefined
      ? {}
      : { reasoning_content: assistant.reasoning_content }),
    ...(assistant === null || assistant.output_parts.length === 0
      ? {}
      : { output_parts: assistant.output_parts }),
    ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
    ...(isError === undefined ? {} : { is_error: isError }),
    ...(retryable === undefined ? {} : { retryable }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(record.role !== "tool" || data === undefined ? {} : { data }),
    ...(envelope.is_meta === true ? { is_meta: true } : {}),
    ...(replyTo === undefined
      ? {}
      : {
          reply_to: ("messageId" in replyTo ? [replyTo] : replyTo).map((quoted) => ({
            message_id: quoted.messageId,
            role: quoted.role,
            content: quoted.content
          }))
        }),
    ...(recipe === undefined ? {} : { recipe }),
    ...(questionAnswer === undefined ? {} : { question_answer: questionAnswer }),
    ...(connection === undefined ? {} : { connection }),
    ...(fromChat === undefined ? {} : { from_chat: fromChat }),
    ...(forwardedFrom === undefined ? {} : { forwarded_from: forwardedFrom }),
    ...(sentFrom === undefined ? {} : { sent_from: sentFrom }),
    ...(agentResult === undefined ? {} : { agent_result: agentResult }),
    ...(interaction === undefined ? {} : { interaction }),
    ...(envelope.compact === true ? { compact: true } : {}),
    turn_id: record.envelope.turn_id,
    ...(automation === undefined ? {} : { automation }),
    ...(communication === undefined ? {} : { communication }),
    ...(update === undefined ? {} : { update })
  }
  const warnings = [
    ...(assistant?.warnings ?? []),
    ...(surface === "conversation" &&
    record.role === "user" &&
    envelope.communication !== undefined &&
    communication === undefined
      ? ["communication envelope is invalid; dropped"]
      : [])
  ]
  if (record.role !== "user") return { message: { ...projected, role: record.role }, warnings }
  const images = contentImages(contentValue)
  return {
    message: {
      ...projected,
      role: "user",
      ...(images.length === 0 ? {} : { images })
    },
    warnings
  }
}

type HistoryToolCalls = NonNullable<HistoryResponse["messages"][number]["tool_calls"]>

const conversationPartsAfterReconciliation = (
  surface: Surface,
  parts: ReadonlyArray<HistoryAssistantOutputPart>,
  textReconciled: boolean,
  storedContent: string
): ReadonlyArray<HistoryAssistantOutputPart> => {
  if (surface === "work" || textReconciled) return parts
  if (storedContent.length === 0) return parts.filter((part) => part.type !== "text")
  return []
}

interface AssistantSurfaceProjection {
  readonly content: string
  readonly tool_calls: HistoryToolCalls
  readonly reasoning_content?: string
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
  const runtimeCalls = historyToolCalls(envelope.tool_calls).map((call) => {
    const callMetadata = resultMetadata.get(call.id)
    const receipt =
      (call.name === "email_send" ||
        call.name === "email_reply" ||
        call.name === "email_forward") &&
      callMetadata?.isError === false
        ? Option.getOrUndefined(decodeGmailSendReceipt(callMetadata.data?.["gmail_send_receipt"]))
        : undefined
    return {
      ...call,
      execution: "runtime" as const,
      ...(callMetadata === undefined
        ? {}
        : {
            is_error: callMetadata.isError,
            retryable: callMetadata.retryable,
            ...(callMetadata.durationMs === undefined
              ? {}
              : { duration_ms: callMetadata.durationMs }),
            ...(receipt === undefined ? {} : { gmail_send_receipt: receipt })
          })
    }
  })
  const providerCalls = historyProviderToolCalls(envelope.provider_tool_calls).map((call) => ({
    ...call,
    execution: "provider" as const
  }))
  const callsById = new Map(runtimeCalls.map((call) => [call.id, call]))
  const providerIds = new Set(providerCalls.map((call) => call.id))
  const warnings: Array<string> = []

  const decoded = Array.isArray(envelope.output_parts)
    ? envelope.output_parts.flatMap(
        (part, sourceIndex): ReadonlyArray<HistoryAssistantOutputPart> => {
          if (!Predicate.isObject(part)) return []
          if (part.type === "text" && Predicate.isString(part.text) && part.text.length > 0) {
            const phase =
              part.phase === "commentary" || part.phase === "final_answer" ? part.phase : undefined
            return [
              {
                type: "text",
                text: part.text,
                ...(phase === undefined ? {} : { phase }),
                source_index: sourceIndex
              }
            ]
          }
          if (part.type === "reasoning" && Predicate.isString(part.text) && part.text.length > 0) {
            return [{ type: "reasoning", text: part.text, source_index: sourceIndex }]
          }
          if (
            part.type === "tool_call" &&
            Predicate.isString(part.tool_call_id) &&
            (part.execution === "runtime" || part.execution === "provider")
          ) {
            const known =
              part.execution === "runtime"
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
      : decoded.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
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
    .map((call) => {
      if (surface === "work") return call
      const result = pinnedResults.get(call.id)
      const data = resultMetadata.get(call.id)?.data
      return {
        ...call,
        ...(result === undefined ? {} : { result }),
        ...(data === undefined ? {} : { data })
      }
    })
  const reasoning =
    Predicate.isString(envelope.reasoning_content) && envelope.reasoning_content.length > 0
      ? envelope.reasoning_content
      : undefined
  return {
    content: surface === "conversation" ? storedContent : "",
    tool_calls: toolCalls,
    ...(surface === "work" && reasoning !== undefined ? { reasoning_content: reasoning } : {}),
    output_parts: outputParts,
    warnings
  }
}

const storedToolCallIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter(Predicate.isObject)
        .flatMap((call) => (Predicate.isString(call.id) ? [call.id] : []))
    : []

export const historyToolCallIds = (records: ReadonlyArray<TranscriptMessageRecord>): string[] => [
  ...new Set(
    records.flatMap((record) => [
      ...storedToolCallIds(record.envelope.provider_tool_calls),
      ...storedToolCallIds(record.envelope.tool_calls),
      ...(record.role === "tool" && Predicate.isString(record.envelope.tool_call_id)
        ? [record.envelope.tool_call_id]
        : [])
    ])
  )
]

export const contentText = (value: unknown): string => {
  if (Predicate.isString(value)) return value
  if (!Array.isArray(value)) return ""
  return value
    .filter(Predicate.isObject)
    .flatMap((block) => (Predicate.isString(block.text) ? [block.text] : []))
    .join("\n\n")
}

const decodeHistoryImage = Schema.decodeUnknownOption(ChatImageSchema)

const contentImages = (
  value: unknown
): NonNullable<HistoryResponse["messages"][number]["images"]> => {
  if (!Array.isArray(value)) return []
  return value.flatMap((block) => {
    const decoded = decodeHistoryImage(block)
    return Option.isSome(decoded) ? [decoded.value] : []
  })
}

const contentContext = (
  value: unknown
): NonNullable<HistoryResponse["messages"][number]["context"]> => {
  if (!Array.isArray(value)) return []
  return value.filter(Predicate.isObject).flatMap((block) => {
    if (block.type !== "context" || !Predicate.isString(block.content_type)) return []
    const metadata = Predicate.isObject(block.metadata)
      ? Object.fromEntries(
          Object.entries(block.metadata).filter((entry): entry is [string, string] =>
            Predicate.isString(entry[1])
          )
        )
      : undefined
    return [
      {
        type: "context" as const,
        content_type: block.content_type,
        ...(block.content === null || Predicate.isString(block.content)
          ? { content: block.content }
          : {}),
        ...(metadata === undefined ? {} : { metadata })
      }
    ]
  })
}

const decodeToolOutcome = Schema.decodeUnknownOption(ToolOutcomeSchema)
const decodeGmailSendReceipt = Schema.decodeUnknownOption(GmailSendReceiptSchema)

export const historyToolCalls = (
  value: unknown
): NonNullable<HistoryResponse["messages"][number]["tool_calls"]> => {
  if (!Array.isArray(value)) return []
  return value.filter(Predicate.isObject).flatMap((call) => {
    const fn = Predicate.isObject(call.function) ? call.function : undefined
    const fallbackName = fn !== undefined && Predicate.isString(fn.name) ? fn.name : undefined
    const name = Predicate.isString(call.name) ? call.name : fallbackName
    if (!Predicate.isString(call.id) || name === undefined) return []
    const argumentsValue = call.arguments ?? fn?.arguments ?? {}
    const outcome = Option.getOrUndefined(decodeToolOutcome(call.outcome))
    return [
      {
        id: call.id,
        name,
        arguments: Predicate.isString(argumentsValue)
          ? argumentsValue
          : JSON.stringify(argumentsValue),
        ...(Predicate.isNumber(call.started_at) ? { started_at: call.started_at } : {}),
        ...(call.parent_id === null || Predicate.isString(call.parent_id)
          ? { parent_id: call.parent_id }
          : {}),
        ...(Predicate.isString(call.display_name) ? { display_name: call.display_name } : {}),
        ...(Predicate.isString(call.display_title) ? { display_title: call.display_title } : {}),
        ...(Predicate.isString(call.result) ? { result: call.result } : {}),
        kind: Predicate.isString(call.kind) ? call.kind : "tool",
        ...(call.icon === null || Predicate.isString(call.icon) ? { icon: call.icon } : {}),
        ...(call.noun === null || Predicate.isString(call.noun) ? { noun: call.noun } : {}),
        ...(call.source === null || Predicate.isString(call.source) ? { source: call.source } : {}),
        ...(call.presentation === "conversation" || call.presentation === "status"
          ? { presentation: call.presentation }
          : {}),
        ...(Predicate.isBoolean(call.is_error) ? { is_error: call.is_error } : {}),
        ...(call.retryable === null || Predicate.isBoolean(call.retryable)
          ? { retryable: call.retryable }
          : {}),
        ...(outcome === undefined ? {} : { outcome })
      }
    ]
  })
}

const historyProviderToolCalls = (
  value: unknown
): NonNullable<HistoryResponse["messages"][number]["tool_calls"]> => {
  if (!Array.isArray(value)) return []
  return value.filter(Predicate.isObject).flatMap((call) => {
    if (!Predicate.isString(call.id) || !Predicate.isString(call.name)) return []
    const outcome = Option.getOrUndefined(decodeToolOutcome(call.outcome))
    return [
      {
        id: call.id,
        name: call.name,
        arguments: Predicate.isString(call.arguments)
          ? call.arguments
          : JSON.stringify(call.arguments ?? {}),
        ...(Predicate.isNumber(call.started_at) ? { started_at: call.started_at } : {}),
        ...(call.parent_id === null || Predicate.isString(call.parent_id)
          ? { parent_id: call.parent_id }
          : {}),
        kind: Predicate.isString(call.kind) ? call.kind : "tool",
        display_name: Predicate.isString(call.display_name) ? call.display_name : call.name,
        ...(call.icon === null || Predicate.isString(call.icon) ? { icon: call.icon } : {}),
        ...(call.noun === null || Predicate.isString(call.noun) ? { noun: call.noun } : {}),
        ...(call.source === null || Predicate.isString(call.source) ? { source: call.source } : {}),
        ...(Predicate.isString(call.result) ? { result: call.result } : {}),
        ...(Predicate.isBoolean(call.is_error) ? { is_error: call.is_error } : {}),
        ...(call.retryable === null || Predicate.isBoolean(call.retryable)
          ? { retryable: call.retryable }
          : {}),
        ...(outcome === undefined ? {} : { outcome }),
        ...(Array.isArray(call.source_refs) && call.source_refs.length > 0
          ? { data: { source_refs: call.source_refs } }
          : {})
      }
    ]
  })
}

const isSessionHandoff = (envelope: Readonly<Record<string, unknown>>): boolean => {
  const receipt = envelope.compaction
  return Predicate.isObject(receipt) && receipt.kind === "session_handoff"
}
