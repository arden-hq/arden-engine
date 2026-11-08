import { parseCalendarDay, utcDay } from "@arden-hq/std/time"
import { toolRefusal } from "./tool-failure.js"
import { countOf } from "@arden-hq/std/count"

interface CalendarGuest {
  readonly email?: string | undefined
  readonly self?: boolean | undefined
}

const guestsOtherThanSelf = (
  guests: ReadonlyArray<CalendarGuest>,
  account: string
): ReadonlyArray<string> => {
  const own = account.toLowerCase()
  const seen = new Set<string>()
  const others: string[] = []
  for (const guest of guests) {
    const email = guest.email?.trim()
    if (email === undefined || email === "" || guest.self === true) continue
    const key = email.toLowerCase()
    if (key === own || seen.has(key)) continue
    seen.add(key)
    others.push(email)
  }
  return others
}

export const notifiedGuests = ({
  account,
  current,
  replacement
}: {
  readonly account: string
  readonly current: ReadonlyArray<CalendarGuest>
  readonly replacement?: ReadonlyArray<string> | undefined
}): ReadonlyArray<string> =>
  guestsOtherThanSelf([...current, ...(replacement ?? []).map((email) => ({ email }))], account)

export const sendUpdatesFor = (notified: ReadonlyArray<string>): "all" | "none" =>
  notified.length > 0 ? "all" : "none"

export const notifyPhrase = (notified: ReadonlyArray<string>): string =>
  notified.length === 0 ? "" : `notify ${countOf(notified.length, "guest")}`

const PRIMARY = "primary"

export const calendarEventRef = (account: string, calendarId: string, eventId: string): string =>
  calendarId === PRIMARY
    ? `${account}:${eventId}`
    : `${account}:${encodeURIComponent(calendarId)}:${eventId}`

export const parseCalendarEventRef = (
  value: string,
  calendarId?: string
): { readonly account: string; readonly calendarId: string; readonly id: string } | undefined => {
  const parts = value.split(":")
  const valid = (account: string | undefined, id: string | undefined) =>
    account !== undefined &&
    id !== undefined &&
    account.includes("@") &&
    id !== "" &&
    !/\s/u.test(id)
  if (parts.length === 2) {
    const [account, id] = parts
    return valid(account, id)
      ? { account: account ?? "", calendarId: calendarId ?? PRIMARY, id: id ?? "" }
      : undefined
  }
  if (parts.length === 3) {
    const [account, calendar, id] = parts
    if (!valid(account, id) || calendar === undefined || calendar === "") return undefined
    try {
      const decoded = decodeURIComponent(calendar)
      if (calendarId !== undefined && calendarId !== decoded) return undefined
      return { account: account ?? "", calendarId: decoded, id: id ?? "" }
    } catch {
      return undefined
    }
  }
  return undefined
}

export type EventScope = "this" | "series"

export const scopeTargetId = (
  scope: EventScope,
  event: { readonly id: string; readonly recurringEventId?: string | undefined }
): string => (scope === "series" ? (event.recurringEventId ?? event.id) : event.id)

export const isRecurring = (event: {
  readonly recurringEventId?: string | undefined
  readonly recurrence?: ReadonlyArray<string> | undefined
}): boolean => event.recurringEventId !== undefined || (event.recurrence?.length ?? 0) > 0

const dayOf = (value: string): Date | undefined =>
  parseCalendarDay(value) === undefined ? undefined : new Date(`${value}T00:00:00Z`)

const dayString = (day: Date): string => utcDay(day.getTime())

const addDays = (day: Date, days: number): Date => new Date(day.getTime() + days * 86_400_000)

const requireDay = (value: string, field: string): Date => {
  const day = dayOf(value)
  if (day === undefined) {
    throw toolRefusal(`${field} must be a calendar date, YYYY-MM-DD.`, "Invalid event date")
  }
  return day
}

/**
 * An all-day event in Google's shape. Callers give the first and last day
 * inclusive (`end` defaults to `start`); Google's `end.date` is the day after
 * the last day.
 */
export const allDayTimes = (
  start: string,
  end: string | undefined
): { readonly start: { readonly date: string }; readonly end: { readonly date: string } } => {
  const first = requireDay(start, "start")
  const last = end === undefined ? first : requireDay(end, "end")
  if (last < first) {
    throw toolRefusal("An all-day end date cannot be before start.", "Invalid event date")
  }
  return { start: { date: dayString(first) }, end: { date: dayString(addDays(last, 1)) } }
}

/**
 * An all-day event's days as callers read them: Google's exclusive `end.date`
 * becomes the last day inclusive. A missing or unreadable end is a one-day event.
 */
export const allDayDays = (
  start: string,
  endExclusive: string | undefined
): { readonly start: string; readonly end: string } => {
  const first = dayOf(start)
  const exclusive = endExclusive === undefined ? undefined : dayOf(endExclusive)
  if (first === undefined || exclusive === undefined || exclusive <= first) {
    return { start, end: start }
  }
  return { start, end: dayString(addDays(exclusive, -1)) }
}

const RECURRENCE_LINE = /^(?:RRULE:|(?:EXDATE|RDATE)[:;])\S/u

export const checkRecurrence = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const trimmed = lines.map((line) => line.trim())
  const bad = trimmed.find((line) => !RECURRENCE_LINE.test(line))
  if (bad !== undefined) {
    throw toolRefusal(
      `Recurrence lines must start with RRULE:, EXDATE: or RDATE:, such as RRULE:FREQ=WEEKLY;BYDAY=MO. Got ${JSON.stringify(bad)}.`,
      "Invalid recurrence"
    )
  }
  return trimmed
}

/** Google's popup reminder overrides; an empty list means no reminders. */
export const reminderBody = (
  minutes: ReadonlyArray<number>
): {
  readonly useDefault: false
  readonly overrides: ReadonlyArray<{ readonly method: "popup"; readonly minutes: number }>
} => ({
  useDefault: false,
  overrides: [...new Set(minutes)].map((value) => ({ method: "popup" as const, minutes: value }))
})

export type RsvpAnswer = "accepted" | "declined" | "tentative"

export type RsvpPlan =
  | { readonly kind: "organizer" }
  | { readonly kind: "not_attendee" }
  | {
      readonly kind: "answer"
      /** The PATCH body: attendeesOmitted limits the update to this participant. */
      readonly body: {
        readonly attendees: ReadonlyArray<Readonly<Record<string, unknown>>>
        readonly attendeesOmitted: true
      }
    }

const isEntry = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * An RSVP changes the one attendee entry marked `self` (the account the call is
 * made as) and nothing else of the event. Only the person's own entry is sent, with
 * `attendeesOmitted` so concurrent responses by other guests are preserved. The organizer has no response to give.
 */
export const planRsvp = (input: {
  readonly organizerIsSelf: boolean
  readonly attendees: unknown
  readonly answer: RsvpAnswer
  readonly comment: string | undefined
}): RsvpPlan => {
  if (input.organizerIsSelf) return { kind: "organizer" }
  const entries = Array.isArray(input.attendees) ? input.attendees.filter(isEntry) : []
  const own = entries.find((entry) => entry["self"] === true)
  if (own === undefined) return { kind: "not_attendee" }
  const answered = {
    ...own,
    responseStatus: input.answer,
    ...(input.comment === undefined ? {} : { comment: input.comment })
  }
  return { kind: "answer", body: { attendees: [answered], attendeesOmitted: true } }
}
