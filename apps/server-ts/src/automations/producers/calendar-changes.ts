import type { GoogleAccount } from "@arden-hq/protocol/google"
import { Clock, Effect, Option, Schema } from "effect"

import {
  calendarEventTarget,
  calendarSyncUrl,
  CalendarSyncPageSchema,
  PRIMARY_CALENDAR,
  type CalendarSyncEvent
} from "../../google/calendar-client.js"
import type { GoogleConnectionError } from "../../google/errors.js"
import { GoogleConnections } from "../../google/service.js"
import type { AutomationTriggerEvent } from "../../persistence/automations/model.js"
import { AutomationTriggers } from "../../persistence/automations/triggers.js"
import type { AutomationEventProducer } from "../event-producer.js"
import { hasReadyCalendar } from "./calendar.js"
import { calendarKeyPart, watchedCalendars } from "./calendar-sources.js"
import { iso } from "../../runtime/clock.js"

const MAX_SYNC_PAGES = 100
const CREATED_WITHIN_MS = 2 * 60_000
const SUMMARY_CHARS = 200
const KEPT_ATTENDEES = 20

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

const calendarChangedEvent = (input: {
  readonly account: Pick<GoogleAccount, "id" | "email">
  readonly calendarId?: string
  readonly event: CalendarSyncEvent
  readonly known: KnownEvent | undefined
  readonly nowMs: number
}): AutomationTriggerEvent | undefined => {
  const { event } = input
  const change = calendarChange(event, input.known, input.nowMs)
  if (change === undefined) return undefined
  const fields = change === "cancelled" ? input.known : knownEvent(event)
  if (fields === undefined) return undefined
  const revision = change === "created" ? "created" : (event.updated ?? event.status ?? "")
  const calendarId = input.calendarId ?? PRIMARY_CALENDAR
  return {
    eventType: "calendar.changed",
    eventKey: `${input.account.id}${calendarKeyPart(calendarId)}:${event.id}:${revision}`,
    producedBy: null,
    chainDepth: 0,
    touches: {
      target: calendarEventTarget(event.id),
      changedAt: event.updated ?? iso(input.nowMs)
    },
    context: {
      event: {
        change,
        event_id: event.id,
        account: input.account.email,
        ...(calendarId === PRIMARY_CALENDAR ? {} : { calendar_id: calendarId }),
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
  }
}

const calendarSyncChanges = (input: {
  readonly account: Pick<GoogleAccount, "id" | "email">
  readonly calendarId: string
  readonly items: ReadonlyArray<CalendarSyncEvent>
  readonly known: KnownEvents
  readonly baseline: boolean
  readonly nowMs: number
}): { readonly events: ReadonlyArray<AutomationTriggerEvent>; readonly known: KnownEvents } => {
  const events = input.baseline
    ? []
    : input.items.flatMap((event) => {
        const changed = calendarChangedEvent({
          account: input.account,
          calendarId: input.calendarId,
          event,
          known: input.known[event.id],
          nowMs: input.nowMs
        })
        return changed === undefined ? [] : [changed]
      })
  const kept = new Map(Object.entries(input.known))
  for (const event of input.items) {
    if (event.status === "cancelled") kept.delete(event.id)
    else kept.set(event.id, knownEvent(event))
  }
  return {
    events,
    known: Object.fromEntries([...kept].filter(([, known]) => !endedBefore(known, input.nowMs)))
  }
}

const syncCalendar = Effect.fn("AutomationTriggerProducers.syncCalendar")(function* (
  account: GoogleAccount,
  calendarId: string
) {
  const google = yield* GoogleConnections
  const triggers = yield* AutomationTriggers
  const nowMs = yield* Clock.currentTimeMillis
  const ref = {
    eventType: "calendar.changed",
    source: `calendar:${account.id}${calendarKeyPart(calendarId)}`
  } as const
  const stored = yield* triggers.readSourceCursor(ref)
  const cursor = stored === undefined ? undefined : Option.getOrUndefined(decodeCursor(stored))
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
  return yield* triggers.publishSourceEvents({
    ...ref,
    events: changes.events,
    cursor: JSON.stringify({ sync_token: synced.syncToken, events: changes.known })
  })
})

const readPages = Effect.fnUntraced(function* (
  google: GoogleConnections["Service"],
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

const pollCalendarChanges = Effect.fn("AutomationTriggerProducers.pollCalendarChanges")(
  function* () {
    const google = yield* GoogleConnections
    const accounts = (yield* google.list()).accounts.filter(hasReadyCalendar)
    let queued = 0
    const failures: Array<string> = []
    for (const account of accounts) {
      for (const calendarId of yield* watchedCalendars(account)) {
        yield* syncCalendar(account, calendarId).pipe(
          Effect.tap((outcome) =>
            Effect.sync(() => {
              queued += outcome.queued
            })
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              failures.push(`${account.id}${calendarKeyPart(calendarId)}: ${error.message}`)
            })
          )
        )
      }
    }
    if (failures.length > 0)
      return yield* new CalendarSyncError({
        message: `Calendar sync incomplete (${queued} queued): ${failures.join("; ")}`
      })
    return { queued }
  }
)

export const calendarChangedEventProducer: AutomationEventProducer<
  "calendar.changed",
  GoogleConnections | AutomationTriggers
> = {
  eventType: "calendar.changed",
  available: ({ googleAccounts }) => googleAccounts.some(hasReadyCalendar),
  source: { kind: "on_demand", poll: () => pollCalendarChanges() },
  failureMessage: "Google Calendar change trigger producer failed"
}
