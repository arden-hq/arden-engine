import {
  DEFAULT_EVENT_LEAD_MINUTES,
  type EventAutomationTrigger
} from "@arden-hq/protocol/automations"
import { accountReadyFor, type GoogleAccount } from "@arden-hq/protocol/google"
import type { JsonValue } from "@arden-hq/protocol"
import { machineTimeZone, parseCalendarDay } from "@arden-hq/std/time"
import { DateTime, Effect, Option, Schema } from "effect"

import {
  calendarEventListUrl,
  CalendarEventListSchema,
  PRIMARY_CALENDAR,
  type CalendarListedEvent
} from "../../google/calendar-client.js"
import { GoogleConnections } from "../../google/service.js"
import { allDayFireAt, nextWallDay, wallDayOf, wallInstant } from "../../google/zoned-time.js"
import type { AutomationTriggerEvent } from "../../persistence/automations/model.js"
import { AutomationTriggers } from "../../persistence/automations/triggers.js"
import type { AutomationEventProducer } from "../event-producer.js"
import { readField } from "../events.js"
import { calendarKeyPart, watchedCalendars } from "./calendar-sources.js"

const CALENDAR_PAGE_SIZE = 250
const MAX_CALENDAR_PAGES = 100

class AutomationTriggerProducerError extends Schema.TaggedError<AutomationTriggerProducerError>()(
  "AutomationTriggerProducerError",
  {
    source: Schema.Literal("calendar"),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

const producerError = (message: string, cause?: unknown): AutomationTriggerProducerError =>
  new AutomationTriggerProducerError({
    source: "calendar",
    message,
    ...(cause === undefined ? {} : { cause })
  })

export const hasReadyCalendar = (account: GoogleAccount): boolean =>
  accountReadyFor(account, "calendar")

export interface PolledCalendarEvent {
  readonly account: Pick<GoogleAccount, "id" | "email">
  readonly calendarId: string
  readonly event: CalendarListedEvent
  readonly nowMs: number
}

export const calendarEventContext = (
  input: PolledCalendarEvent,
  fields: Readonly<Record<string, JsonValue>>
): Record<string, JsonValue> => {
  const { event } = input
  const organizer = event.organizer?.email?.trim()
  const response = event.attendees?.find((attendee) => attendee.self === true)?.responseStatus
  return {
    event_id: event.id,
    account: input.account.email,
    ...(input.calendarId === PRIMARY_CALENDAR ? {} : { calendar_id: input.calendarId }),
    summary: event.summary?.trim() || "Busy",
    ...fields,
    location: event.location?.trim() || null,
    attendees: (event.attendees ?? []).flatMap((attendee) => {
      const email = attendee.email?.trim()
      return email === undefined || email.length === 0 ? [] : [email]
    }),
    ...(organizer === undefined || organizer === "" ? {} : { organizer }),
    ...(response === undefined ? {} : { my_response: response })
  }
}

export const calendarEventId = (input: PolledCalendarEvent): string =>
  `${input.account.id}${calendarKeyPart(input.calendarId)}:${input.event.id}`

const timedInstant = (value: string | undefined): DateTime.DateTime | undefined => {
  if (value === undefined) return undefined
  const parsed = DateTime.make(value)
  return Option.isNone(parsed) ? undefined : parsed.value
}

const approachingEvents = (
  input: PolledCalendarEvent & { readonly horizonMs: number; readonly timeZone: string }
): ReadonlyArray<AutomationTriggerEvent> => {
  const { event, nowMs } = input
  if (event.status === "cancelled") return []
  const timed = timedInstant(event.start.dateTime)
  if (timed !== undefined) {
    const startMs = DateTime.toEpochMillis(timed)
    if (startMs < nowMs || startMs > input.horizonMs) return []
    const start = DateTime.formatIso(timed)
    return [
      {
        eventType: "event_approaching",
        eventKey: `${calendarEventId(input)}:${start}`,
        producedBy: null,
        chainDepth: 0,
        context: {
          event: calendarEventContext(input, {
            start,
            minutes_until: Math.max(0, Math.ceil((startMs - nowMs) / 60_000))
          })
        }
      }
    ]
  }
  const day = event.start.date === undefined ? undefined : parseCalendarDay(event.start.date)
  if (event.start.date === undefined || day === undefined) return []
  const fireAt = allDayFireAt(event.start.date, input.timeZone) ?? Infinity
  const dayEnd = wallInstant(nextWallDay(day), 0, input.timeZone)
  if (nowMs < fireAt || nowMs >= dayEnd) return []
  return [
    {
      eventType: "event_approaching",
      eventKey: `${calendarEventId(input)}:${event.start.date}`,
      producedBy: null,
      chainDepth: 0,
      context: {
        event: calendarEventContext(input, {
          start: event.start.date,
          all_day: true,
          minutes_until: 0
        })
      }
    }
  ]
}

const horizonMinutes = (triggers: ReadonlyArray<EventAutomationTrigger>): number =>
  Math.max(0, ...triggers.map((trigger) => trigger.lead_minutes ?? DEFAULT_EVENT_LEAD_MINUTES))

export const pollCalendarEvents = Effect.fn("AutomationTriggerProducers.pollCalendarEvents")(
  function* (input: {
    readonly fromMs: number
    readonly toMs: number
    readonly toEvents: (polled: PolledCalendarEvent) => ReadonlyArray<AutomationTriggerEvent>
  }) {
    const google = yield* GoogleConnections
    const automationTriggers = yield* AutomationTriggers

    const accounts = yield* google.list().pipe(
      Effect.mapError((cause) =>
        producerError("Google Calendar accounts could not be read", cause)
      ),
      Effect.map((result) => result.accounts.filter(hasReadyCalendar))
    )
    if (accounts.length === 0) return { events: 0, queued: 0 }

    const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
    let events = 0
    let queued = 0
    const failures: Array<{
      readonly accountId: string
      readonly error: AutomationTriggerProducerError
    }> = []

    for (const account of accounts) {
      const calendars = yield* watchedCalendars(account)
      for (const calendarId of calendars) {
        yield* Effect.gen(function* () {
          let pageToken: string | undefined
          const seenTokens = new Set<string>()
          let finished = false
          for (let page = 0; page < MAX_CALENDAR_PAGES; page += 1) {
            const url = calendarEventListUrl({
              calendarId,
              timeMin: DateTime.formatIso(DateTime.makeUnsafe(input.fromMs)),
              timeMax: DateTime.formatIso(DateTime.makeUnsafe(input.toMs)),
              maxResults: CALENDAR_PAGE_SIZE,
              ...(pageToken === undefined ? {} : { pageToken })
            })
            const result = yield* google
              .request({ service: "calendar", url: url.href, accountRef: account.id })
              .pipe(
                Effect.mapError((cause) =>
                  producerError("Google Calendar event polling failed", cause)
                )
              )
            const output = yield* Schema.decodeUnknownEffect(CalendarEventListSchema)(
              result.value
            ).pipe(
              Effect.mapError((cause) =>
                producerError("Google Calendar returned invalid event data", cause)
              )
            )
            for (const event of output.items ?? []) {
              for (const raised of input.toEvents({ account, calendarId, event, nowMs })) {
                const dispatched = yield* automationTriggers.dispatchEvent(raised)
                events += 1
                queued += dispatched.queued
              }
            }
            const next = output.nextPageToken
            if (next === undefined || next.length === 0) {
              finished = true
              break
            }
            if (seenTokens.has(next)) {
              return yield* producerError("Google Calendar repeated an event page token")
            }
            seenTokens.add(next)
            pageToken = next
          }
          if (!finished)
            return yield* producerError("Google Calendar event polling exceeded the page limit")
        }).pipe(
          Effect.catchTag("AutomationTriggerProducerError", (error) =>
            Effect.sync(() => {
              failures.push({
                accountId: `${account.id}${calendarKeyPart(calendarId)}`,
                error
              })
            })
          )
        )
      }
    }
    if (failures.length > 0) {
      return yield* producerError(
        `Calendar polling incomplete: ${failures.map(({ accountId, error }) => `${accountId}: ${error.message}`).join("; ")}`,
        { failures, events, queued }
      )
    }
    return { events, queued }
  }
)

const pollApproaching = Effect.fn("AutomationTriggerProducers.pollCalendar")(function* (
  triggers: ReadonlyArray<EventAutomationTrigger>
) {
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
  const timeZone = machineTimeZone()
  const horizonMs = nowMs + horizonMinutes(triggers) * 60_000
  const today = wallDayOf(nowMs, timeZone)
  return yield* pollCalendarEvents({
    fromMs: wallInstant(today, 0, timeZone),
    toMs: Math.max(horizonMs, wallInstant(nextWallDay(today), 0, timeZone)),
    toEvents: (polled) => approachingEvents({ ...polled, horizonMs, timeZone })
  })
})

export const calendarEventProducer: AutomationEventProducer<
  "event_approaching",
  GoogleConnections | AutomationTriggers
> = {
  eventType: "event_approaching",
  available: ({ googleAccounts }) => googleAccounts.some(hasReadyCalendar),
  accepts: (trigger, event) => {
    if (trigger.lead_minutes === undefined) return true
    const minutes = readField(event.context, "event.minutes_until")
    return typeof minutes === "number" && minutes <= trigger.lead_minutes
  },
  source: { kind: "on_demand", poll: pollApproaching },
  failureMessage: "Google Calendar Automation trigger producer failed"
}
