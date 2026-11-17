import type { GoogleAccount } from "@arden-hq/protocol/google"
import { clipLine } from "@arden-hq/std/text"
import { Clock, Effect, Option, Schema } from "effect"

import {
  calendarSyncUrl,
  CalendarSyncPageSchema,
  PRIMARY_CALENDAR,
  type CalendarSyncEvent
} from "../../google/calendar-client.js"
import type { GoogleConnectionError } from "../../google/errors.js"
import type { GoogleConnections } from "../../google/service.js"
import type {
  ConnectionItemDetail,
  FetchedConnectionItem
} from "../../persistence/connections/store.js"
import { iso } from "../../runtime/clock.js"
import { redactText } from "./filter.js"

const MAX_SYNC_PAGES = 100
const CREATED_WITHIN_MS = 2 * 60_000
const SUMMARY_CHARS = 200
const KEPT_ATTENDEES = 20

/** The account a calendar's items and cursor are stored under: the Google
 *  account, plus the calendar when it is not the primary one. */
export const calendarItemAccount = (accountId: string, calendarId: string): string =>
  calendarId === PRIMARY_CALENDAR ? accountId : `${accountId}:${calendarId}`

class CalendarSyncError extends Schema.TaggedError<CalendarSyncError>()("CalendarSyncError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

const KnownEventSchema = Schema.Struct({
  summary: Schema.String,
  start: Schema.optionalKey(Schema.String),
  end: Schema.optionalKey(Schema.String),
  location: Schema.String,
  attendees: Schema.Array(Schema.String),
  recurring: Schema.Boolean,
  organizer: Schema.optionalKey(Schema.String),
  my_response: Schema.optionalKey(Schema.String)
})
type KnownEvent = (typeof KnownEventSchema)["Type"]
type KnownEvents = { readonly [eventId: string]: KnownEvent }

const SyncCursorSchema = Schema.Struct({
  sync_token: Schema.NonEmptyString,
  events: Schema.optionalKey(Schema.Record(Schema.String, KnownEventSchema))
})
const decodeCursor = Schema.decodeUnknownOption(Schema.fromJsonString(SyncCursorSchema))

type CalendarChange = "created" | "changed" | "cancelled"

const timeOf = (value: string | undefined) => {
  const ms = Date.parse(value ?? "")
  return Number.isFinite(ms) ? ms : undefined
}

const endedBefore = (event: Pick<KnownEvent, "start" | "end" | "recurring">, nowMs: number) => {
  const end = timeOf(event.end) ?? timeOf(event.start)
  return !event.recurring && end !== undefined && end < nowMs
}

const knownEvent = (event: CalendarSyncEvent): KnownEvent => {
  const start = event.start?.dateTime ?? event.start?.date
  const end = event.end?.dateTime ?? event.end?.date
  const organizer = event.organizer?.email?.trim()
  const response = event.attendees?.find((attendee) => attendee.self === true)?.responseStatus
  return {
    summary: event.summary?.trim().slice(0, SUMMARY_CHARS) ?? "",
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
    location: event.location?.trim() ?? "",
    attendees: (event.attendees ?? [])
      .flatMap((attendee) => {
        const email = attendee.email?.trim()
        return email === undefined || email === "" ? [] : [email]
      })
      .slice(0, KEPT_ATTENDEES),
    recurring: event.recurrence !== undefined,
    ...(organizer === undefined || organizer === "" ? {} : { organizer }),
    ...(response === undefined ? {} : { my_response: response })
  }
}

const calendarChange = (
  event: CalendarSyncEvent,
  known: KnownEvent | undefined,
  nowMs: number
): CalendarChange | undefined => {
  if (event.status === "cancelled")
    return known === undefined || endedBefore(known, nowMs) ? undefined : "cancelled"
  if (endedBefore(knownEvent(event), nowMs)) return undefined
  const created = Date.parse(event.created ?? "")
  const updated = Date.parse(event.updated ?? "")
  return Number.isFinite(created) &&
    Number.isFinite(updated) &&
    updated - created <= CREATED_WITHIN_MS
    ? "created"
    : "changed"
}

/** What one calendar change says, as the `calendar.changed` event's fields. */
const changeDetail = (input: {
  readonly account: Pick<GoogleAccount, "email">
  readonly calendarId: string
  readonly event: CalendarSyncEvent
  readonly change: CalendarChange
  readonly fields: KnownEvent
}): ConnectionItemDetail => {
  const { event, change, fields } = input
  return {
    change,
    event_id: event.id,
    account: input.account.email,
    ...(input.calendarId === PRIMARY_CALENDAR ? {} : { calendar_id: input.calendarId }),
    summary: fields.summary,
    ...(fields.start === undefined ? {} : { start: fields.start }),
    ...(change === "cancelled" && fields.end !== undefined ? { end: fields.end } : {}),
    location: fields.location,
    attendees: [...fields.attendees],
    recurring: fields.recurring,
    ...(fields.organizer === undefined ? {} : { organizer: fields.organizer }),
    ...(fields.my_response === undefined ? {} : { my_response: fields.my_response }),
    ...(event.updated === undefined ? {} : { updated: event.updated })
  }
}

const CHANGE_WORDS: Record<CalendarChange, string> = {
  created: "New event",
  changed: "Event changed",
  cancelled: "Event cancelled"
}

const calendarItem = (input: {
  readonly account: Pick<GoogleAccount, "id" | "email">
  readonly calendarId: string
  readonly event: CalendarSyncEvent
  readonly known: KnownEvent | undefined
  readonly nowMs: number
}): FetchedConnectionItem | undefined => {
  const { event } = input
  const change = calendarChange(event, input.known, input.nowMs)
  if (change === undefined) return undefined
  const fields = change === "cancelled" ? input.known : knownEvent(event)
  if (fields === undefined) return undefined
  const revision = change === "created" ? "created" : (event.updated ?? event.status ?? "")
  const when = fields.start === undefined ? "" : `, starts ${fields.start}`
  const where = fields.location === "" ? "" : `, at ${fields.location}`
  return {
    source: "calendar",
    account: calendarItemAccount(input.account.id, input.calendarId),
    externalId: `${event.id}:${revision}`,
    threadKey: event.id,
    title: clipLine(redactText(fields.summary, 300) || "Event without a title", 300),
    sender: fields.organizer === undefined ? undefined : clipLine(fields.organizer, 200),
    receivedAt: event.updated ?? iso(input.nowMs),
    snippet: clipLine(redactText(`${CHANGE_WORDS[change]}${when}${where}.`, 280), 280),
    detail: changeDetail({ ...input, change, fields })
  }
}

const calendarSyncChanges = (input: {
  readonly account: Pick<GoogleAccount, "id" | "email">
  readonly calendarId: string
  readonly items: ReadonlyArray<CalendarSyncEvent>
  readonly known: KnownEvents
  readonly baseline: boolean
  readonly nowMs: number
}): { readonly items: ReadonlyArray<FetchedConnectionItem>; readonly known: KnownEvents } => {
  const items = input.baseline
    ? []
    : input.items.flatMap((event) => {
        const item = calendarItem({
          account: input.account,
          calendarId: input.calendarId,
          event,
          known: input.known[event.id],
          nowMs: input.nowMs
        })
        return item === undefined ? [] : [item]
      })
  const kept = new Map(Object.entries(input.known))
  for (const event of input.items) {
    if (event.status === "cancelled") kept.delete(event.id)
    else kept.set(event.id, knownEvent(event))
  }
  return {
    items,
    known: Object.fromEntries([...kept].filter(([, known]) => !endedBefore(known, input.nowMs)))
  }
}

/**
 * The changes of one calendar since its cursor, as items. The first fetch of a
 * calendar (no cursor, or one Google no longer accepts) only takes a baseline:
 * it returns no items, so old history never arrives as new.
 */
export const fetchCalendar = Effect.fn("ConnectionItems.fetchCalendar")(function* (input: {
  readonly google: Pick<GoogleConnections["Service"], "request">
  readonly account: GoogleAccount
  readonly calendarId: string
  readonly cursor: string | undefined
}) {
  const { google, account, calendarId } = input
  const nowMs = yield* Clock.currentTimeMillis
  const cursor =
    input.cursor === undefined ? undefined : Option.getOrUndefined(decodeCursor(input.cursor))
  const read = (from: { readonly syncToken: string } | { readonly timeMin: string }) =>
    readPages(google, account, calendarId, from)
  const fresh = { timeMin: iso(nowMs) }
  const synced =
    cursor === undefined
      ? { ...(yield* read(fresh)), baseline: true }
      : yield* read({ syncToken: cursor.sync_token }).pipe(
          Effect.map((pages) => ({ ...pages, baseline: false })),
          Effect.catchTag("GoogleConnectionError", (error) =>
            error.diagnostic.kind === "http" && error.diagnostic.status === 410
              ? read(fresh).pipe(Effect.map((pages) => ({ ...pages, baseline: true })))
              : Effect.fail(error)
          )
        )
  const changes = calendarSyncChanges({
    account,
    calendarId,
    items: synced.items,
    known: synced.baseline ? {} : (cursor?.events ?? {}),
    baseline: synced.baseline,
    nowMs
  })
  return {
    cursor: JSON.stringify({ sync_token: synced.syncToken, events: changes.known }),
    items: changes.items
  }
})

const readPages = Effect.fnUntraced(function* (
  google: Pick<GoogleConnections["Service"], "request">,
  account: GoogleAccount,
  calendarId: string,
  from: { readonly syncToken: string } | { readonly timeMin: string }
): Effect.fn.Return<
  { readonly items: ReadonlyArray<CalendarSyncEvent>; readonly syncToken: string },
  CalendarSyncError | GoogleConnectionError
> {
  const items: Array<CalendarSyncEvent> = []
  let pageToken: string | undefined
  for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
    const result = yield* google.request({
      service: "calendar",
      url: calendarSyncUrl({ ...from, pageToken, calendarId }).href,
      accountRef: account.id
    })
    const output = yield* Schema.decodeUnknownEffect(CalendarSyncPageSchema)(result.value).pipe(
      Effect.mapError(
        (cause) =>
          new CalendarSyncError({ message: "Google Calendar returned invalid sync data", cause })
      )
    )
    items.push(...(output.items ?? []))
    if (output.nextSyncToken !== undefined && output.nextSyncToken !== "")
      return { items, syncToken: output.nextSyncToken }
    if (output.nextPageToken === undefined || output.nextPageToken === pageToken)
      return yield* new CalendarSyncError({
        message: "Google Calendar ended a sync without a token"
      })
    pageToken = output.nextPageToken
  }
  return yield* new CalendarSyncError({ message: "Google Calendar sync exceeded the page limit" })
})
