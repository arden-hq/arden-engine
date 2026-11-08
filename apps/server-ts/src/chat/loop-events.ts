import type { AgentEvent, StopReason } from "@arden-hq/loop"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { chatDecoders, isEphemeralChatEvent } from "@arden-hq/protocol/chat"
import { isRunMinted } from "../persistence/transcript/minted-ids.js"

export type ChatEventBatch = ReadonlyArray<ChatProjectionEvent>

export const coalesceEventBatches = (
  batches: ReadonlyArray<ChatEventBatch>
): ReadonlyArray<ChatEventBatch> => {
  const output: ChatProjectionEvent[][] = []
  let pending: ChatProjectionEvent[] = []
  let sawLive = false
  for (const batch of batches) {
    for (const event of batch) {
      const live = isEphemeralChatEvent(event)
      if (!live && sawLive) {
        output.push(pending)
        pending = []
        sawLive = false
      }
      pending.push(event)
      sawLive ||= live
    }
  }
  if (pending.length > 0) output.push(pending)
  return output
}

export interface LoopEventMapper {
  readonly map: (event: AgentEvent) => ReadonlyArray<ChatEventBatch>
  readonly finalText: (messageId: string | null, content: string) => ReadonlyArray<ChatEventBatch>
  readonly hasEnded: (messageId: string | null) => boolean
  readonly superseded: (finish: RunFinish) => ReadonlyArray<string>
}

interface RunFinish {
  readonly stopReason: StopReason
  readonly terminalTextId: string | null
  readonly text: string
}

interface HistoryRecord {
  readonly role: string
  readonly message_id?: unknown
  readonly rejected_message_ids?: unknown
}

export const answerFixInHistory = (
  messages: ReadonlyArray<HistoryRecord>,
  assistantMessageId: string
): ReadonlyArray<string> =>
  messages.flatMap((message) => {
    const rejected = message.rejected_message_ids
    if (
      message.role !== "user" ||
      typeof message.message_id !== "string" ||
      !Array.isArray(rejected) ||
      rejected.length === 0 ||
      !rejected.every(
        (id): id is string => typeof id === "string" && isRunMinted(assistantMessageId, id)
      )
    )
      return []
    return [...rejected, message.message_id]
  })

interface TerminalCandidate {
  readonly role: string
  readonly message_id: string
  readonly content?: unknown
}

export const terminalTextAnchor = (messages: ReadonlyArray<TerminalCandidate>): string | null => {
  let anchor: string | null = null
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") break
    if (typeof message.content === "string" && message.content.length > 0) {
      anchor = message.message_id
    }
  }
  return (
    anchor ??
    [...messages].reverse().find((message) => message.role === "assistant")?.message_id ??
    null
  )
}

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const nullableStringField = (value: unknown): string | null | undefined =>
  value === null ? null : stringField(value)

const gmailSendReceipt = (data: unknown) => {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined
  try {
    const value = Object.entries(data).find(([key]) => key === "gmail_send_receipt")?.[1]
    return chatDecoders.gmailSendReceipt(value)
  } catch {
    return undefined
  }
}

const toolStart = (
  event: Extract<AgentEvent, { readonly _tag: "ToolStarted" }>
): ChatProjectionEvent => {
  const kind = stringField(event.host.kind)
  const displayTitle = stringField(event.host.display_title)
  const icon = nullableStringField(event.host.icon)
  const noun = nullableStringField(event.host.noun)
  const source = nullableStringField(event.host.source)
  const presentation =
    event.host.presentation === "conversation" || event.host.presentation === "status"
      ? event.host.presentation
      : undefined
  return {
    type: "TOOL_CALL_START",
    tool_call_id: event.tool_id,
    tool_call_name: event.name,
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
    ...(event.parent_id === undefined ? {} : { parent_id: event.parent_id }),
    display_name: stringField(event.host.display_name) ?? event.name,
    ...(displayTitle === undefined ? {} : { display_title: displayTitle }),
    ...(kind === undefined ? {} : { kind }),
    ...(icon === undefined ? {} : { icon }),
    ...(noun === undefined ? {} : { noun }),
    ...(source === undefined ? {} : { source }),
    ...(presentation === undefined ? {} : { presentation }),
    execution: "execution" in event ? (event.execution ?? "runtime") : "runtime"
  }
}

export const makeLoopEventMapper = (
  assistantMessageId: string,
  runId: string,
  priorSuperseded: ReadonlyArray<string> = []
): LoopEventMapper => {
  const startedTextIds = new Set([assistantMessageId])
  const endedTextIds = new Set<string>()
  const endedTextOrder: Array<string> = []
  const currentText = new Map<string, string>()
  const currentReasoning = new Map<string, string>()
  const supersededIds: Array<string> = [...priorSuperseded]

  const textId = (messageId: string | null): string => messageId ?? assistantMessageId
  const textStart = (messageId: string): ChatProjectionEvent | null => {
    if (startedTextIds.has(messageId)) return null
    startedTextIds.add(messageId)
    return {
      type: "TEXT_MESSAGE_START",
      message_id: messageId,
      role: "assistant"
    }
  }
  const textContent = (messageId: string, content: string): ReadonlyArray<ChatEventBatch> => {
    if (content.length === 0) return []
    currentText.set(messageId, (currentText.get(messageId) ?? "") + content)
    const start = textStart(messageId)
    return [
      [
        ...(start === null ? [] : [start]),
        {
          type: "TEXT_MESSAGE_CONTENT",
          message_id: messageId,
          delta: content
        }
      ]
    ]
  }

  const map = (event: AgentEvent): ReadonlyArray<ChatEventBatch> => {
    switch (event._tag) {
      case "TextStarted": {
        const start = textStart(textId(event.message_id))
        return start === null ? [] : [[start]]
      }
      case "TextEnded": {
        const messageId = textId(event.message_id)
        if (event.content.length === 0 && (currentText.get(messageId) ?? "").length === 0) return []
        if (!endedTextIds.has(messageId)) endedTextOrder.push(messageId)
        endedTextIds.add(messageId)
        currentText.set(messageId, event.content)
        return [
          [
            {
              type: "TEXT_MESSAGE_END",
              message_id: messageId,
              content: event.content
            }
          ]
        ]
      }
      case "TextPhaseResolved":
        return [
          [
            {
              type: "TEXT_MESSAGE_PHASE",
              message_id: textId(event.message_id),
              phase: event.phase
            }
          ]
        ]
      case "TextDelta":
        return textContent(textId(event.message_id), event.content)
      case "ReasoningStarted":
        return [
          [
            {
              type: "REASONING_MESSAGE_START",
              message_id: event.message_id,
              role: "reasoning"
            }
          ]
        ]
      case "ReasoningDelta": {
        if (event.content.length === 0) return []
        currentReasoning.set(
          event.message_id,
          (currentReasoning.get(event.message_id) ?? "") + event.content
        )
        return [
          [
            {
              type: "REASONING_MESSAGE_CONTENT",
              message_id: event.message_id,
              delta: event.content
            }
          ]
        ]
      }
      case "ReasoningEnded": {
        const content = currentReasoning.get(event.message_id)
        currentReasoning.delete(event.message_id)
        return [
          [
            {
              type: "REASONING_MESSAGE_END",
              message_id: event.message_id,
              ...(content === undefined ? {} : { content })
            }
          ]
        ]
      }
      case "InputTaken":
        return [[{ type: "input_taken", run_id: runId }]]
      case "ModelStreamRetry":
        return [
          [
            {
              type: "stream_retry",
              run_id: runId,
              attempt: event.attempt,
              max_attempts: event.max_attempts
            }
          ]
        ]
      case "ModelResponseReset": {
        for (const sourceId of event.message_ids) {
          startedTextIds.delete(sourceId)
          endedTextIds.delete(sourceId)
          currentText.delete(sourceId)
          currentReasoning.delete(sourceId)
          const endedAt = endedTextOrder.indexOf(sourceId)
          if (endedAt >= 0) endedTextOrder.splice(endedAt, 1)
        }
        return [
          [
            {
              type: "model_response_reset",
              message_ids: [...new Set(event.message_ids)],
              tool_call_ids: [...event.tool_call_ids]
            }
          ]
        ]
      }
      case "FinalTextSuperseded":
        supersededIds.push(...event.message_ids, event.correction_message_id)
        return [
          [
            {
              type: "final_text_superseded",
              run_id: runId,
              message_ids: [...event.message_ids],
              state: "retrying"
            }
          ]
        ]
      case "ToolInputStarted":
      case "ToolInputDelta":
      case "ToolInputEnded":
        return []
      case "ToolStarted":
        return [
          [toolStart(event)],
          [
            {
              type: "TOOL_CALL_ARGS",
              tool_call_id: event.tool_id,
              delta: JSON.stringify(event.args),
              execution: event.execution ?? "runtime"
            }
          ],
          [
            {
              type: "TOOL_CALL_END",
              tool_call_id: event.tool_id,
              execution: event.execution ?? "runtime"
            }
          ]
        ]
      case "ToolCompleted": {
        const kind = stringField(event.host.kind)
        const receipt =
          event.is_error ||
          (event.name !== "email_send" &&
            event.name !== "email_reply" &&
            event.name !== "email_forward")
            ? undefined
            : gmailSendReceipt(event.data)
        return [
          [
            {
              type: "TOOL_CALL_RESULT",
              tool_call_id: event.tool_id,
              name: event.name,
              content: event.result,
              preview: event.preview,
              display_name: stringField(event.host.display_name) ?? event.name,
              is_error: event.is_error,
              retryable: event.retryable,
              duration_ms: event.duration_ms,
              data: event.data,
              ...(receipt === undefined ? {} : { gmail_send_receipt: receipt }),
              execution: event.execution ?? "runtime",
              ...(kind === undefined ? {} : { kind }),
              ...(event.host.source_refs === undefined
                ? {}
                : { source_refs: event.host.source_refs })
            }
          ]
        ]
      }
      case "ToolPaused":
        return []
      case "ToolProgress":
        return [
          [
            {
              type: "TOOL_CALL_PROGRESS",
              tool_call_id: event.tool_call_id,
              message: event.message,
              ...(event.data === undefined ? {} : { data: event.data })
            }
          ]
        ]
    }
  }

  return {
    map,
    finalText: (sourceId, content) => {
      if (content.length === 0) return []
      const messageId = textId(sourceId)
      const turnStart = endedTextOrder.indexOf(messageId)
      const turnIds = turnStart < 0 ? [] : endedTextOrder.slice(turnStart)
      const streamed = turnIds.map((id) => currentText.get(id) ?? "").join("")
      if (turnIds.length > 0 && streamed.trim() === content.trim()) return []
      if (turnIds.length > 1) {
        for (const id of turnIds) {
          startedTextIds.delete(id)
          endedTextIds.delete(id)
          currentText.delete(id)
        }
        endedTextOrder.splice(turnStart, turnIds.length)
        const start = textStart(messageId)
        endedTextOrder.push(messageId)
        endedTextIds.add(messageId)
        currentText.set(messageId, content)
        return [
          [
            { type: "model_response_reset", message_ids: turnIds, tool_call_ids: [] },
            ...(start === null ? [] : [start]),
            { type: "TEXT_MESSAGE_END", message_id: messageId, content }
          ]
        ]
      }
      const targetId = turnIds.at(-1) ?? messageId
      if (currentText.get(targetId) === content) return []
      const start = textStart(targetId)
      if (!endedTextIds.has(targetId)) endedTextOrder.push(targetId)
      endedTextIds.add(targetId)
      currentText.set(targetId, content)
      return [
        [
          ...(start === null ? [] : [start]),
          { type: "TEXT_MESSAGE_END", message_id: targetId, content }
        ]
      ]
    },
    hasEnded: (sourceId) => endedTextIds.has(textId(sourceId)),
    superseded: (finish) => {
      const ids = new Set(supersededIds)
      const fixStands =
        finish.stopReason === "end_turn" &&
        finish.text.trim().length > 0 &&
        finish.terminalTextId !== null &&
        !ids.has(finish.terminalTextId)
      return fixStands ? [...ids] : []
    }
  }
}
