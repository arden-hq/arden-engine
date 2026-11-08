import { isoDateTimeWords, parseCalendarDay } from "@arden-hq/std/time"
import { Option, Predicate, Schema } from "effect"

import { calendarEventUrl, PRIMARY_CALENDAR } from "../google/calendar-client.js"
import { currentMillis, iso } from "../runtime/clock.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import { allDayText, event, eventData, type CalendarEvent } from "./google-calendar-events.js"
import { CalendarDateTimeSchema } from "./google-calendar-schemas.js"
import {
  allDayTimes,
  isRecurring,
  parseCalendarEventRef,
  planRsvp,
  scopeTargetId,
  type EventScope,
  type RsvpAnswer
} from "./google-calendar-rules.js"
import { googleCall } from "./google-request.js"
import { randomUUID } from "node:crypto"
import { decodeOpaque } from "../lib/opaque-ref.js"
import { toolRefusal } from "./tool-failure.js"

const CalendarPageRefSchema = Schema.Struct({
  version: Schema.Literal(1),
  query: Schema.String,
  limit: Schema.Number,
  min: Schema.String,
  max: Schema.NullOr(Schema.String),
  token: Schema.String,
  account: Schema.String,
  calendar: Schema.optionalKey(Schema.String)
})

const parseDateTime = (value: string, field: string): string => {
  const date = new Date(value)
  if (
    !Schema.is(CalendarDateTimeSchema)(value) ||
    !Number.isFinite(date.getTime()) ||
    parseCalendarDay(value.slice(0, 10)) === undefined
  ) {
    throw toolRefusal(
      `${field} must be a valid ISO date and time with an explicit offset or Z.`,
      `Invalid ${field.toLowerCase()}`
    )
  }
  return date.toISOString()
}

export const validEmail = (value: string): boolean =>
  value === value.trim() && /^[^@\s]+@[^@\s]+$/u.test(value)

export const parseEventRef = (
  value: string,
  calendarId?: string
): { readonly account: string; readonly calendarId: string; readonly id: string } => {
  const ref = parseCalendarEventRef(value, calendarId)
  if (ref === undefined) {
    throw toolRefusal(
      "Use the exact account-qualified event_ref returned by calendar_search.",
      "Invalid event reference"
    )
  }
  return ref
}

const dateTimeBody = (value: string, timezone: string | undefined) => ({
  dateTime: parseDateTime(value, "Date and time"),
  ...(timezone === undefined ? {} : { timeZone: timezone })
})

export const decodePageRef = (
  value: string | undefined,
  query: string,
  timeMin: string | undefined,
  timeMax: string | undefined,
  limit: number,
  accountRef: string | undefined,
  calendarId: string | undefined
): {
  readonly min: string
  readonly max?: string
  readonly token?: string
  readonly accountRef?: string
  readonly calendarId: string
} => {
  if (value === undefined) {
    const min =
      timeMin === undefined
        ? iso(currentMillis() - 24 * 60 * 60 * 1_000)
        : parseDateTime(timeMin, "time_min")
    const max = timeMax === undefined ? undefined : parseDateTime(timeMax, "time_max")
    return {
      min,
      ...(max === undefined ? {} : { max }),
      ...(accountRef === undefined ? {} : { accountRef }),
      calendarId: calendarId ?? PRIMARY_CALENDAR
    }
  }
  try {
    const decoded = Option.getOrUndefined(decodeOpaque(CalendarPageRefSchema, value))
    if (
      decoded === undefined ||
      decoded.query !== query ||
      decoded.limit !== limit ||
      (accountRef !== undefined && accountRef !== decoded.account) ||
      (calendarId !== undefined && calendarId !== (decoded.calendar ?? PRIMARY_CALENDAR)) ||
      (timeMin !== undefined && parseDateTime(timeMin, "time_min") !== decoded.min) ||
      (timeMax !== undefined && parseDateTime(timeMax, "time_max") !== decoded.max)
    )
      throw new Error("mismatch")
    return {
      min: decoded.min,
      ...(decoded.max === null ? {} : { max: decoded.max }),
      token: decoded.token,
      accountRef: decoded.account,
      calendarId: decoded.calendar ?? PRIMARY_CALENDAR
    }
  } catch {
    throw toolRefusal(
      "The Calendar page_ref is invalid or belongs to another search.",
      "Invalid page reference"
    )
  }
}

/**
 * The start and end of a write. A patch also clears the other form's fields
 * (`date` against `dateTime`), so an event can change between all-day and timed.
 */
export const eventTimes = (
  input: {
    readonly allDay: boolean
    readonly start: string
    readonly end: string | undefined
    readonly timezone: string | undefined
  },
  patch: boolean
) => {
  if (input.allDay) {
    const days = allDayTimes(input.start, input.end)
    const clear = patch ? { dateTime: null, timeZone: null } : {}
    return { start: { ...days.start, ...clear }, end: { ...days.end, ...clear } }
  }
  if (input.end === undefined) {
    throw toolRefusal("A timed event needs an end.", "Incomplete event time")
  }
  const start = parseDateTime(input.start, "start")
  const end = parseDateTime(input.end, "end")
  if (end <= start) throw toolRefusal("Event end must be after start.", "Invalid event time")
  const clear = patch ? { date: null } : {}
  return {
    start: { ...dateTimeBody(start, input.timezone), ...clear },
    end: { ...dateTimeBody(end, input.timezone), ...clear }
  }
}

export const meetRequest = () => ({
  createRequest: {
    requestId: randomUUID(),
    conferenceSolutionKey: { type: "hangoutsMeet" }
  }
})

export const reminderText = (minutes: ReadonlyArray<number>): string =>
  minutes.length === 0
    ? "None"
    : minutes.map((value) => (value === 0 ? "at start" : `${value} min before`)).join(", ")

export const whenText = (data: ReturnType<typeof eventData>): string =>
  allDayText(data) ?? `${isoDateTimeWords(data.start)} to ${isoDateTimeWords(data.end)}`

export const scopeText = (item: CalendarEvent, targetId: string): string | undefined => {
  if (!isRecurring(item)) return undefined
  return targetId !== item.id || item.recurringEventId === undefined
    ? "Every event in the series"
    : "This event only"
}

export const timeFields = (input: {
  readonly start?: string | undefined
  readonly end?: string | undefined
  readonly all_day?: boolean | undefined
  readonly timezone?: string | undefined
}): ReadonlyArray<{ readonly label: string; readonly value: string }> => {
  if (input.start === undefined) return []
  if (input.all_day === true) {
    const days = { start: input.start, end: input.end ?? input.start, all_day: true }
    return [{ label: "When", value: allDayText(days) ?? input.start }]
  }
  return [
    { label: "Starts", value: isoDateTimeWords(input.start) },
    ...(input.end === undefined ? [] : [{ label: "Ends", value: isoDateTimeWords(input.end) }]),
    ...(input.timezone === undefined ? [] : [{ label: "Time zone", value: input.timezone }])
  ]
}

export const currentEvent = async (
  google: GoogleToolConnections,
  ref: { readonly account: string; readonly calendarId: string; readonly id: string },
  scope: EventScope,
  signal: AbortSignal
) => {
  const fetchOne = (id: string) =>
    googleCall({
      google,
      service: "calendar",
      url: calendarEventUrl(id, ref.calendarId).href,
      accountRef: ref.account,
      signal
    })
  const response = await fetchOne(ref.id)
  const item = event(response.value)
  const targetId = scopeTargetId(scope, item)
  const targetResponse = targetId === item.id ? response : await fetchOne(targetId)
  const target = targetId === item.id ? item : event(targetResponse.value)
  return {
    account: response.account.email,
    item,
    target,
    targetId,
    rawTarget: targetResponse.value
  }
}

export const RESPONSE_WORDS: Readonly<
  Record<RsvpAnswer, { readonly verb: string; readonly button: string; readonly answer: string }>
> = {
  accepted: { verb: "Accepted", button: "Accept", answer: "Yes" },
  declined: { verb: "Declined", button: "Decline", answer: "No" },
  tentative: { verb: "Answered maybe to", button: "Reply maybe", answer: "Maybe" }
}

export const rsvpFor = (
  current: {
    readonly target: CalendarEvent
    readonly rawTarget: unknown
  },
  input: { readonly response: RsvpAnswer; readonly comment?: string | undefined }
) => {
  const plan = planRsvp({
    organizerIsSelf: current.target.organizer?.self === true,
    attendees: Predicate.hasProperty(current.rawTarget, "attendees")
      ? current.rawTarget.attendees
      : undefined,
    answer: input.response,
    comment: input.comment
  })
  switch (plan.kind) {
    case "organizer":
      throw toolRefusal(
        "You organize this event, so there is no invitation to answer. Use calendar_edit_event to change it or calendar_delete_event to cancel it.",
        "You are the organizer"
      )
    case "not_attendee":
      throw toolRefusal(
        "You are not a guest of this event, so there is no invitation to answer.",
        "Not invited"
      )
    case "answer":
      return plan.body
  }
}

/** Exact write target: primary is an API alias, so name it beside the account. */
export const calendarIdentityFields = (
  account: string,
  calendarId: string
): ReadonlyArray<{ readonly label: string; readonly value: string }> => [
  { label: "Account", value: account },
  { label: "Calendar", value: calendarId === PRIMARY_CALENDAR ? "Primary calendar" : calendarId }
]
