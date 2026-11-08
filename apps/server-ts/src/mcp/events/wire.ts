import type { JsonValue } from "@arden-hq/protocol"
import type { McpEvent, McpEventDelivery } from "@arden-hq/protocol/mcp"
import { Option, Predicate, Schema } from "effect"

/**
 * The MCP protocol 2026-07-28 wire Arden speaks to a server that offers it
 * (stateless requests, `server/discover`), and its Events extension
 * (`io.modelcontextprotocol/events`, SEP-3415).
 */

export const EVENTS_PROTOCOL_VERSION = "2026-07-28"
const EVENTS_EXTENSION = "io.modelcontextprotocol/events"
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion"
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities"
const CLIENT_INFO_META = "io.modelcontextprotocol/clientInfo"
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo"

const SUBSCRIPTION_ID_META = "io.modelcontextprotocol/subscriptionId"

const EVENT_NOTIFICATIONS = {
  active: "notifications/events/active",
  event: "notifications/events/event",
  heartbeat: "notifications/events/heartbeat",
  error: "notifications/events/error",
  terminated: "notifications/events/terminated"
} as const

export const EVENT_ERROR_CODES = {
  invalidParams: -32602,
  notFound: -32023,
  forbidden: -32024,
  resourceExhausted: -32025,
  unsupported: -32026
} as const

const MAX_NAME_LENGTH = 256
const MAX_DESCRIPTION_LENGTH = 32_768
const MAX_CURSOR_LENGTH = 64 * 1_024
const MAX_SCHEMA_BYTES = 128 * 1_024

const CursorSchema = Schema.optional(Schema.NullOr(Schema.String))
const cursorOf = (cursor: string | null | undefined): string | undefined =>
  cursor === null || cursor === undefined || cursor.length > MAX_CURSOR_LENGTH ? undefined : cursor

const EventDefinitionSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_NAME_LENGTH)),
  description: Schema.optional(Schema.String),
  delivery: Schema.Array(Schema.String),
  inputSchema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
})

const EventsListResultSchema = Schema.Struct({
  events: Schema.Array(Schema.Unknown),
  nextCursor: Schema.optional(Schema.String)
})

const OccurrenceSchema = Schema.Struct({
  eventId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  name: Schema.String,
  timestamp: Schema.String,
  data: Schema.Record(Schema.String, Schema.Json),
  cursor: CursorSchema
})

const PollResultSchema = Schema.Struct({
  events: Schema.Array(OccurrenceSchema),
  cursor: CursorSchema,
  truncated: Schema.optional(Schema.Boolean),
  hasMore: Schema.optional(Schema.Boolean),
  nextPollMs: Schema.optional(Schema.Number)
})

const PositionSchema = Schema.Struct({
  cursor: CursorSchema,
  truncated: Schema.optional(Schema.Boolean)
})

const EventErrorSchema = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Number,
    message: Schema.String
  })
})

export interface McpEventOccurrence {
  readonly eventId: string
  readonly name: string
  readonly timestamp: string
  readonly data: Readonly<Record<string, JsonValue>>
}

export interface McpEventsPage {
  readonly events: ReadonlyArray<McpEvent>
  readonly nextCursor: string | undefined
}

export interface McpEventsPoll {
  readonly events: ReadonlyArray<McpEventOccurrence>
  readonly cursor: string | undefined
  readonly truncated: boolean
  readonly hasMore: boolean
  readonly nextPollMs: number | undefined
}

export interface McpEventError {
  readonly code: number
  readonly message: string
}

export type McpStreamSignal =
  | { readonly kind: "active"; readonly cursor: string | undefined; readonly truncated: boolean }
  | {
      readonly kind: "event"
      readonly occurrence: McpEventOccurrence
      readonly cursor: string | undefined
    }
  | { readonly kind: "heartbeat"; readonly cursor: string | undefined }
  | { readonly kind: "error"; readonly error: McpEventError }
  | { readonly kind: "terminated"; readonly error: McpEventError }

const isDelivery = (value: string): value is McpEventDelivery =>
  value === "poll" || value === "push" || value === "webhook"

export const decodeEventsPage = (value: unknown): McpEventsPage | undefined => {
  const page = Schema.decodeUnknownOption(EventsListResultSchema)(value)
  if (Option.isNone(page)) return undefined
  const events = page.value.events.flatMap((candidate): ReadonlyArray<McpEvent> => {
    const definition = Schema.decodeUnknownOption(EventDefinitionSchema)(candidate)
    if (Option.isNone(definition)) return []
    const delivery = definition.value.delivery.filter(isDelivery)
    if (!delivery.includes("poll") && !delivery.includes("push")) return []
    const inputSchema = definition.value.inputSchema ?? { type: "object" }
    if (Buffer.byteLength(JSON.stringify(inputSchema), "utf8") > MAX_SCHEMA_BYTES) return []
    return [
      {
        name: definition.value.name,
        description: (definition.value.description ?? "").slice(0, MAX_DESCRIPTION_LENGTH),
        delivery,
        inputSchema
      }
    ]
  })
  return { events, nextCursor: page.value.nextCursor }
}

const occurrenceOf = (value: typeof OccurrenceSchema.Type): McpEventOccurrence => ({
  eventId: value.eventId,
  name: value.name,
  timestamp: value.timestamp,
  data: value.data
})

export const decodePollResult = (value: unknown): McpEventsPoll | undefined => {
  const result = Schema.decodeUnknownOption(PollResultSchema)(value)
  if (Option.isNone(result)) return undefined
  return {
    events: result.value.events.map(occurrenceOf),
    cursor: cursorOf(result.value.cursor),
    truncated: result.value.truncated === true,
    hasMore: result.value.hasMore === true,
    nextPollMs: result.value.nextPollMs
  }
}

export const decodeStreamSignal = (
  method: string,
  params: unknown
): McpStreamSignal | undefined => {
  switch (method) {
    case EVENT_NOTIFICATIONS.active: {
      const position = Schema.decodeUnknownOption(PositionSchema)(params)
      return Option.isNone(position)
        ? undefined
        : {
            kind: "active",
            cursor: cursorOf(position.value.cursor),
            truncated: position.value.truncated === true
          }
    }
    case EVENT_NOTIFICATIONS.event: {
      const occurrence = Schema.decodeUnknownOption(OccurrenceSchema)(params)
      return Option.isNone(occurrence)
        ? undefined
        : {
            kind: "event",
            occurrence: occurrenceOf(occurrence.value),
            cursor: cursorOf(occurrence.value.cursor)
          }
    }
    case EVENT_NOTIFICATIONS.heartbeat: {
      const position = Schema.decodeUnknownOption(PositionSchema)(params)
      return Option.isNone(position)
        ? undefined
        : { kind: "heartbeat", cursor: cursorOf(position.value.cursor) }
    }
    case EVENT_NOTIFICATIONS.error:
    case EVENT_NOTIFICATIONS.terminated: {
      const failure = Schema.decodeUnknownOption(EventErrorSchema)(params)
      if (Option.isNone(failure)) return undefined
      const error = { code: failure.value.error.code, message: failure.value.error.message }
      return method === EVENT_NOTIFICATIONS.error
        ? { kind: "error", error }
        : { kind: "terminated", error }
    }
    default:
      return undefined
  }
}

export const subscriptionIdOf = (params: unknown): string | number | undefined => {
  if (!Predicate.isObject(params) || !("_meta" in params)) return undefined
  const meta = params._meta
  if (!Predicate.isObject(meta) || !(SUBSCRIPTION_ID_META in meta)) return undefined
  const id = meta[SUBSCRIPTION_ID_META]
  return typeof id === "string" || typeof id === "number" ? id : undefined
}

export const statelessParams = (
  params: Readonly<Record<string, unknown>>
): Record<string, unknown> => {
  const meta = params["_meta"]
  return {
    ...params,
    _meta: {
      ...(Predicate.isObject(meta) ? meta : {}),
      [PROTOCOL_VERSION_META]: EVENTS_PROTOCOL_VERSION,
      [CLIENT_INFO_META]: { name: "arden", version: "0.1.0" },
      [CLIENT_CAPABILITIES_META]: { extensions: { [EVENTS_EXTENSION]: {} } }
    }
  }
}

export const isStatelessParams = (params: unknown): boolean =>
  Predicate.isObject(params) &&
  Predicate.isObject(params["_meta"]) &&
  params["_meta"][PROTOCOL_VERSION_META] === EVENTS_PROTOCOL_VERSION

export interface StatelessDiscovery {
  readonly initialize: Record<string, unknown>
  readonly events: boolean
}

export const statelessDiscovery = (
  result: unknown,
  requestedVersion: unknown
): StatelessDiscovery | undefined => {
  if (!Predicate.isObject(result)) return undefined
  const versions = result["supportedVersions"]
  if (!Array.isArray(versions) || !versions.includes(EVENTS_PROTOCOL_VERSION)) return undefined
  const capabilities = Predicate.isObject(result["capabilities"]) ? result["capabilities"] : {}
  const extensions = capabilities["extensions"]
  const meta = result["_meta"]
  const serverInfo = Predicate.isObject(meta) ? meta[SERVER_INFO_META] : undefined
  const instructions = result["instructions"]
  return {
    initialize: {
      protocolVersion: requestedVersion,
      capabilities,
      serverInfo:
        Predicate.isObject(serverInfo) &&
        typeof serverInfo["name"] === "string" &&
        typeof serverInfo["version"] === "string"
          ? serverInfo
          : { name: "mcp", version: "0" },
      ...(typeof instructions === "string" ? { instructions } : {})
    },
    events: Predicate.isObject(extensions) && Predicate.isObject(extensions[EVENTS_EXTENSION])
  }
}
