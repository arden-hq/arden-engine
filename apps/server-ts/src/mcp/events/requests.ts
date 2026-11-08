import type { JsonValue } from "@arden-hq/protocol"
import type { McpEvent } from "@arden-hq/protocol/mcp"

import { currentMillis } from "../../runtime/clock.js"
import { McpEventRequestError, type McpChannel } from "../channel.js"
import { decodeEventsPage, decodePollResult, type McpEventsPoll } from "./wire.js"

const LIST_TIMEOUT_MS = 30_000
const MAX_LIST_PAGES = 20
const MAX_EVENTS = 512
const POLL_TIMEOUT_MS = 60_000

export const listMcpEvents = async (
  channel: Pick<McpChannel, "request">
): Promise<ReadonlyArray<McpEvent>> => {
  const deadline = currentMillis() + LIST_TIMEOUT_MS
  const seen = new Set<string>()
  const events: Array<McpEvent> = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const remaining = deadline - currentMillis()
    if (remaining <= 0) throw new McpEventRequestError("MCP events/list timed out", undefined)
    const result = await channel.request("events/list", cursor === undefined ? {} : { cursor }, {
      timeoutMs: remaining
    })
    const decoded = decodeEventsPage(result)
    if (decoded === undefined) {
      throw new McpEventRequestError("MCP events/list returned an unreadable page", undefined)
    }
    for (const event of decoded.events) {
      if (seen.has(event.name)) continue
      seen.add(event.name)
      events.push(event)
    }
    if (events.length > MAX_EVENTS) {
      throw new McpEventRequestError("MCP server lists too many events", undefined)
    }
    if (decoded.nextCursor === undefined || decoded.nextCursor === cursor) return events
    cursor = decoded.nextCursor
  }
  throw new McpEventRequestError("MCP events/list has too many pages", undefined)
}

export interface McpEventPollRequest {
  readonly name: string
  readonly arguments: Readonly<Record<string, JsonValue>>
  readonly cursor: string | undefined
  readonly maxAgeMs: number
  readonly maxEvents: number
}

export const pollMcpEvents = async (
  channel: Pick<McpChannel, "request">,
  request: McpEventPollRequest,
  signal: AbortSignal
): Promise<McpEventsPoll> => {
  const result = await channel.request(
    "events/poll",
    {
      name: request.name,
      arguments: request.arguments,
      cursor: request.cursor ?? null,
      maxAgeMs: request.maxAgeMs,
      maxEvents: request.maxEvents
    },
    { timeoutMs: POLL_TIMEOUT_MS, signal }
  )
  const decoded = decodePollResult(result)
  if (decoded === undefined) {
    throw new McpEventRequestError("MCP events/poll returned an unreadable result", undefined)
  }
  return decoded
}
