import type { HistoryResponse, TurnWorkResponse } from "@arden-hq/protocol/chat"
import { snapshotJsonBytes as bytes } from "./snapshot-encoding.js"

const ACTIVE_WORK_TAIL_BYTES = 1024 * 1024

export const boundActiveWorkTail = (
  work: TurnWorkResponse,
  capacity = ACTIVE_WORK_TAIL_BYTES
): TurnWorkResponse => {
  if (bytes(work) <= capacity) return work
  const carriers = work.messages.filter((message) => message.role !== "tool")
  const ownerByCall = new Map<string, string>()
  const costByCarrier = new Map<string, number>()
  for (const carrier of carriers) {
    costByCarrier.set(carrier.message_id, bytes(carrier) + 1)
    for (const call of carrier.tool_calls ?? []) {
      if (call.execution !== "provider") ownerByCall.set(call.id, carrier.message_id)
    }
  }
  for (const message of work.messages) {
    if (message.role !== "tool" || message.tool_call_id === undefined) continue
    const owner = ownerByCall.get(message.tool_call_id)
    if (owner !== undefined)
      costByCarrier.set(owner, (costByCarrier.get(owner) ?? 0) + bytes(message) + 1)
  }
  let payloadBytes = [...costByCarrier.values()].reduce((sum, value) => sum + value, 0)
  let start = 0
  const pageAt = (index: number): TurnWorkResponse["page"] => ({
    ...work.page,
    before: carriers[index]?.message_id ?? null,
    after: index < carriers.length ? (carriers.at(-1)?.message_id ?? null) : null,
    has_more_before: index > 0 || work.page.has_more_before
  })
  const removed = new Set<string>()
  for (const carrier of carriers) {
    const headerBytes = bytes({ ...work, messages: [], page: pageAt(start) })
    if (headerBytes + Math.max(0, payloadBytes - 1) <= capacity) break
    start += 1
    removed.add(carrier.message_id)
    payloadBytes -= costByCarrier.get(carrier.message_id) ?? 0
  }
  return {
    ...work,
    messages: work.messages.filter((message) => {
      if (message.role !== "tool") return !removed.has(message.message_id)
      const owner =
        message.tool_call_id === undefined ? undefined : ownerByCall.get(message.tool_call_id)
      return owner !== undefined && !removed.has(owner)
    }),
    page: pageAt(start)
  }
}

export const boundConversationWindow = (
  history: HistoryResponse,
  capacity: number
): HistoryResponse => {
  if (bytes(history) <= capacity) return history
  const fixedBytes =
    bytes({
      ...history,
      messages: [],
      page: { ...history.page, before: null, has_more_before: true }
    }) - bytes(null)
  const messageBytes = history.messages.map((message) => bytes(message) + 1)
  let payloadBytes = messageBytes.reduce((sum, size) => sum + size, 0)
  let start = 0
  for (let index = 0; index < history.messages.length; index += 1) {
    const size =
      fixedBytes +
      bytes(history.messages[start]?.message_id ?? null) +
      Math.max(0, payloadBytes - 1)
    if (size <= capacity || start === history.messages.length - 1) break
    payloadBytes -= messageBytes[start] ?? 0
    start += 1
  }
  if (start === 0) return history
  const messages = history.messages.slice(start)
  return {
    ...history,
    messages,
    page: {
      ...history.page,
      before: messages[0]?.message_id ?? null,
      has_more_before: true
    }
  }
}
