import { messageEnd } from "@arden-hq/protocol/chat"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { AgentEvent, StopReason } from "@arden-hq/loop"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { isEphemeralChatEvent, STREAM_RECORD } from "@arden-hq/protocol/chat"
import { toolProgressEvent, toolResultEvent, toolStartEvents } from "./tool-events.js"

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
  runRecords: ReadonlySet<string>
): ReadonlyArray<string> =>
  messages.flatMap((message) => {
    const rejected = message.rejected_message_ids
    if (
      message.role !== ROLE.interaction ||
      typeof message.message_id !== "string" ||
      !Array.isArray(rejected) ||
      rejected.length === 0 ||
      !rejected.every((id): id is string => typeof id === "string" && runRecords.has(id))
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
    if (message.role !== ROLE.assistant) break
    if (typeof message.content === "string" && message.content.length > 0) {
      anchor = message.message_id
    }
  }
  return (
    anchor ??
    [...messages].reverse().find((message) => message.role === ROLE.assistant)?.message_id ??
    null
  )
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
  const textStart = (messageId: string, recordId = messageId): ChatProjectionEvent | null => {
    if (startedTextIds.has(messageId)) return null
    startedTextIds.add(messageId)
    return {
      type: "TEXT_MESSAGE_START",
      message_id: messageId,
      record: { kind: STREAM_RECORD.part, record_id: recordId },
      role: ROLE.assistant
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
        const start = textStart(textId(event.message_id), event.record_id)
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
              ...messageEnd(event.content)
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
              record: { kind: STREAM_RECORD.part, record_id: event.record_id },
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
              ...messageEnd(content)
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
        return toolStartEvents(event)
      case "ToolCompleted":
        return [[toolResultEvent(event)]]
      case "ToolPaused":
        return []
      case "ToolProgress":
        return [
          [
            toolProgressEvent({
              toolCallId: event.tool_call_id,
              message: event.message,
              data: event.data
            })
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
            { type: "TEXT_MESSAGE_END", message_id: messageId, ...messageEnd(content) }
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
          { type: "TEXT_MESSAGE_END", message_id: targetId, ...messageEnd(content) }
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
