import { ROLE } from "@arden-hq/std/message-vocabulary"
import {
  PAGE_BOUNDS,
  pageBounds,
  type HistoryResponse,
  type TurnWorkResponse
} from "@arden-hq/protocol/chat"
import { snapshotJsonBytes as bytes } from "./snapshot-encoding.js"

const ACTIVE_WORK_TAIL_BYTES = 1024 * 1024

/** A history response without its context budget, which comes from model
 * settings rather than from the Chat's rows. `HistoryResponse` extends a JSON
 * record, so `Omit` would erase its keys; this picks them instead. */
export type HistoryRows = Pick<
  HistoryResponse,
  "messages" | "active_work_tail" | "runtime" | "page" | "turn_shells"
>

export const boundActiveWorkTail = (
  work: TurnWorkResponse,
  capacity = ACTIVE_WORK_TAIL_BYTES
): TurnWorkResponse => {
  if (bytes(work) <= capacity) return work
  const carriers = work.messages.filter((message) => message.role !== ROLE.tool)
  const ownerByCall = new Map<string, string>()
  const costByCarrier = new Map<string, number>()
  for (const carrier of carriers) {
    costByCarrier.set(carrier.message_id, bytes(carrier) + 1)
    for (const call of carrier.tool_calls ?? []) {
      if (call.execution !== "provider") ownerByCall.set(call.id, carrier.message_id)
    }
  }
  for (const message of work.messages) {
    if (message.role !== ROLE.tool || message.tool_call_id === undefined) continue
    const owner = ownerByCall.get(message.tool_call_id)
    if (owner !== undefined)
      costByCarrier.set(owner, (costByCarrier.get(owner) ?? 0) + bytes(message) + 1)
  }
  let payloadBytes = [...costByCarrier.values()].reduce((sum, value) => sum + value, 0)
  let start = 0
  const pageAt = (index: number): TurnWorkResponse["page"] => ({
    ...work.page,
    bounds: pageBounds(
      carriers[index]?.message_id,
      index < carriers.length ? carriers.at(-1)?.message_id : undefined
    ),
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
      if (message.role !== ROLE.tool) return !removed.has(message.message_id)
      const owner =
        message.tool_call_id === undefined ? undefined : ownerByCall.get(message.tool_call_id)
      return owner !== undefined && !removed.has(owner)
    }),
    page: pageAt(start)
  }
}

export const boundConversationWindow = <H extends HistoryRows>(history: H, capacity: number): H => {
  if (bytes(history) <= capacity) return history
  const after = history.page.bounds.kind === PAGE_BOUNDS.bounded ? history.page.bounds.after : ""
  const fixedBytes =
    bytes({
      ...history,
      messages: [],
      page: { ...history.page, bounds: pageBounds("", after), has_more_before: true }
    }) - bytes("")
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
      bounds: pageBounds(messages[0]?.message_id, after),
      has_more_before: true
    }
  }
}
