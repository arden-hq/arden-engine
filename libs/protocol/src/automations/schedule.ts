import { parseCalendarDay } from "@arden-hq/std/time"
import { DateTime, Option, Schema } from "effect"
import type {
  AutomationTriggerInput,
  TimeAutomationTrigger,
  TimeAutomationTriggerInput
} from "./contracts.js"
import { parseIntervalMinutes } from "./interval.js"
import { AutomationTriggerInputSchema } from "./schema.js"

const decodeTriggerInputs = Schema.decodeUnknownOption(Schema.Array(AutomationTriggerInputSchema))

/** A call's `triggers` argument as trigger inputs, when it is a valid list of them. */
export const automationTriggerInputs = (
  value: unknown
): ReadonlyArray<AutomationTriggerInput> | undefined =>
  Option.getOrUndefined(decodeTriggerInputs(value))

/** A 24-hour wall-clock time; the zone is the one the schedule is evaluated in. */
export interface WallTime {
  readonly hour: number
  readonly minute: number
}

/** A calendar date; `month` is one-based. */
export interface CalendarDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** Days of the week, numbered like `Date#getDay`: 0 is Sunday. */
export type Weekdays = ReadonlySet<number>

/**
 * A time trigger decoded once from its stored JSON.
 *
 * - `once`: fires at `at` on the date `on`, then never again.
 * - `next`: fires at the next `at` (a stored `at` without `days`), once.
 * - `daily`: fires at `at` on each of `days`.
 * - `interval`: fires `minutes` after the previous fire, inside the
 *   `[start, end)` window of each allowed day (minutes of the day; an unset
 *   bound is 0 or 1440), moving to the next day's `start` past `end`.
 */
export type TimeSchedule =
  | { readonly kind: "once"; readonly on: CalendarDate; readonly at: WallTime }
  | { readonly kind: "next"; readonly at: WallTime }
  | { readonly kind: "daily"; readonly at: WallTime; readonly days: Weekdays }
  | {
      readonly kind: "interval"
      readonly minutes: number
      readonly window: { readonly start: number; readonly end: number }
      readonly days: Weekdays
    }

/** Where and when to compute the next fire: an instant and the zone whose wall clock the schedule keeps. */
export interface ScheduleClock {
  readonly afterMs: number
  readonly zone: DateTime.TimeZone
}

const MINUTES_PER_DAY = 1_440
const EVERY_DAY: Weekdays = new Set([0, 1, 2, 3, 4, 5, 6])
const DAY_TOKENS = {
  daily: [0, 1, 2, 3, 4, 5, 6],
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6],
  sun: [0],
  mon: [1],
  tue: [2],
  wed: [3],
  thu: [4],
  fri: [5],
  sat: [6]
} as const satisfies Record<string, ReadonlyArray<number>>
type DayToken = keyof typeof DAY_TOKENS

const isDayToken = (token: string): token is DayToken => Object.hasOwn(DAY_TOKENS, token)

const wallTime = (text: string): WallTime | undefined => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour <= 23 && minute <= 59 ? { hour, minute } : undefined
}

const minuteOfDay = (time: WallTime): number => time.hour * 60 + time.minute

const formatWallTime = (time: WallTime): string =>
  `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`

const dayTokens = (text: string): ReadonlyArray<DayToken> | undefined => {
  const tokens = text
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
  const known = tokens.filter(isDayToken)
  return known.length > 0 && known.length === tokens.length ? known : undefined
}

const weekdays = (tokens: ReadonlyArray<DayToken>): Weekdays =>
  new Set(tokens.flatMap((token) => DAY_TOKENS[token]))

const trimmed = (value: string | undefined): string | undefined => value?.trim()

/**
 * One time trigger as its schedule and the normalized JSON the store keeps;
 * `undefined` for any invalid field or combination.
 */
export const decodeTimeTrigger = (
  trigger: TimeAutomationTriggerInput
): { readonly stored: TimeAutomationTrigger; readonly schedule: TimeSchedule } | undefined => {
  const at = trimmed(trigger.at)
  const on = trimmed(trigger.on)
  const every = trimmed(trigger.every)
  const start = trimmed(trigger.start)
  const end = trimmed(trigger.end)
  const dayText = trimmed(trigger.days)
  const days = dayText === undefined ? undefined : dayTokens(dayText)
  if (dayText !== undefined && days === undefined) return undefined
  const storedDays = days === undefined ? {} : { days: days.join(",") }
  if (every !== undefined) {
    if (at !== undefined || on !== undefined) return undefined
    const minutes = parseIntervalMinutes(every)
    const from = start === undefined ? undefined : wallTime(start)
    const to = end === undefined ? undefined : wallTime(end)
    if (
      minutes === undefined ||
      (start !== undefined && from === undefined) ||
      (end !== undefined && to === undefined) ||
      (from !== undefined && to !== undefined && minuteOfDay(from) >= minuteOfDay(to))
    ) {
      return undefined
    }
    return {
      stored: {
        type: "time",
        ...storedDays,
        every: every.toLowerCase(),
        ...(from === undefined ? {} : { start: formatWallTime(from) }),
        ...(to === undefined ? {} : { end: formatWallTime(to) })
      },
      schedule: {
        kind: "interval",
        minutes,
        window: {
          start: from === undefined ? 0 : minuteOfDay(from),
          end: to === undefined ? MINUTES_PER_DAY : minuteOfDay(to)
        },
        days: days === undefined ? EVERY_DAY : weekdays(days)
      }
    }
  }
  if (at === undefined || start !== undefined || end !== undefined) return undefined
  const time = wallTime(at)
  if (time === undefined) return undefined
  if (on !== undefined) {
    const date = parseCalendarDay(on)
    if (days !== undefined || date === undefined) return undefined
    return {
      stored: { type: "time", at: formatWallTime(time), on },
      schedule: { kind: "once", on: date, at: time }
    }
  }
  return {
    stored: { type: "time", at: formatWallTime(time), ...storedDays },
    schedule:
      days === undefined
        ? { kind: "next", at: time }
        : { kind: "daily", at: time, days: weekdays(days) }
  }
}

/** The earliest next fire across time schedules; null without one. */
export const nextScheduleRunAt = (
  times: ReadonlyArray<TimeSchedule>,
  clock: ScheduleClock
): number | null => {
  let earliest: number | null = null
  for (const time of times) {
    const next = nextAutomationRunAt(time, clock)
    if (next !== null && (earliest === null || next < earliest)) earliest = next
  }
  return earliest
}

/**
 * When a new Automation with these triggers would first run, before it
 * exists: the earliest fire of its time triggers, as the server will set
 * `next_run_at` at creation. `undefined` when it cannot be known: a trigger
 * that waits on something else (an event, inactivity, chat turns) may fire
 * first, a time trigger is invalid, or no time trigger would ever fire.
 */
export const firstRunAt = (
  triggers: ReadonlyArray<AutomationTriggerInput>,
  clock: ScheduleClock
): number | undefined => {
  if (triggers.length === 0) return undefined
  const times: Array<TimeSchedule> = []
  for (const trigger of triggers) {
    if (trigger.type !== "time") return undefined
    const decoded = decodeTimeTrigger(trigger)
    if (decoded === undefined) return undefined
    times.push(decoded.schedule)
  }
  return nextScheduleRunAt(times, clock) ?? undefined
}

/**
 * The next fire of one time trigger, on the wall clock of `clock.zone`. A wall
 * time that a DST gap skips resolves forward; one a DST overlap repeats
 * resolves to its first occurrence.
 */
export const nextAutomationRunAt = (
  time: TimeSchedule,
  { afterMs, zone }: ScheduleClock
): number | null => {
  switch (time.kind) {
    case "once": {
      const fire = atWall(zone, time.on, time.at)
      return fire > afterMs ? fire : null
    }
    case "next":
      return nextDailyRunAt(time.at, EVERY_DAY, afterMs, zone)
    case "daily":
      return nextDailyRunAt(time.at, time.days, afterMs, zone)
    case "interval": {
      let fire = afterMs + time.minutes * 60_000
      const due = wallParts(fire, zone)
      if (minuteOfDay(due) < time.window.start)
        fire = atWall(zone, due, windowEdge(time.window.start))
      const settled = wallParts(fire, zone)
      if (minuteOfDay(settled) >= time.window.end) {
        fire = atWall(zone, nextDate(settled), windowEdge(time.window.start))
      }
      const moved = wallParts(fire, zone)
      const date = allowedDate(moved, time.days)
      return date === moved ? fire : atWall(zone, date, moved)
    }
  }
}

const nextDailyRunAt = (
  at: WallTime,
  days: Weekdays,
  afterMs: number,
  zone: DateTime.TimeZone
): number => {
  const today = wallParts(afterMs, zone)
  const first = atWall(zone, today, at)
  return atWall(zone, allowedDate(first > afterMs ? today : nextDate(today), days), at)
}

const windowEdge = (minutes: number): WallTime => ({
  hour: Math.floor(minutes / 60),
  minute: minutes % 60
})

const wallParts = (epochMs: number, zone: DateTime.TimeZone): DateTime.DateTime.PartsWithWeekday =>
  DateTime.toParts(DateTime.makeZonedUnsafe(epochMs, { timeZone: zone }))

const atWall = (
  zone: DateTime.TimeZone,
  date: CalendarDate,
  time: WallTime & { readonly second?: number; readonly millisecond?: number }
): number =>
  DateTime.toEpochMillis(
    DateTime.makeZonedUnsafe(
      {
        year: date.year,
        month: date.month,
        day: date.day,
        hour: time.hour,
        minute: time.minute,
        second: time.second ?? 0,
        millisecond: time.millisecond ?? 0
      },
      { timeZone: zone, adjustForTimeZone: true }
    )
  )

const nextDate = (date: CalendarDate): CalendarDate =>
  DateTime.toPartsUtc(
    DateTime.add(DateTime.makeUnsafe({ year: date.year, month: date.month, day: date.day }), {
      days: 1
    })
  )

const weekday = (date: CalendarDate): number =>
  DateTime.getPartUtc(
    DateTime.makeUnsafe({ year: date.year, month: date.month, day: date.day }),
    "weekDay"
  )

const allowedDate = (date: CalendarDate, days: Weekdays): CalendarDate => {
  let candidate = date
  for (let index = 0; index < 7 && !days.has(weekday(candidate)); index += 1)
    candidate = nextDate(candidate)
  return candidate
}

/**
 * Whether an Automation with these stored triggers fires more than once: an
 * event, idle or count trigger, or a time trigger that is not a one-off
 * (`once`, `next`). Triggers that do not decode count as a one-off.
 */
export const automationRepeats = (triggers: unknown): boolean =>
  (automationTriggerInputs(triggers) ?? []).some((trigger) => {
    if (trigger.type !== "time") return true
    const kind = decodeTimeTrigger(trigger)?.schedule.kind
    return kind === "daily" || kind === "interval"
  })
