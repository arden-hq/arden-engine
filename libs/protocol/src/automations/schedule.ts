import { parseCalendarDay } from "@arden-hq/std/time"
import { DateTime, Option, Schema } from "effect"
import {
  TRIGGER_STATE,
  TRIGGER_TYPE,
  type AutomationTriggerSpec,
  type IntervalWindow,
  type TimeTriggerSchedule,
  type TriggerDays
} from "./trigger-contracts.js"
import { parseIntervalMinutes } from "./interval.js"
import { AutomationTriggerSchema } from "./trigger-schema.js"

const decodeStoredTriggers = Schema.decodeUnknownOption(Schema.Array(AutomationTriggerSchema))

export interface WallTime {
  readonly hour: number
  readonly minute: number
}

export interface CalendarDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

export type Weekdays = ReadonlySet<number>

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

type DecodedTime = { readonly stored: TimeTriggerSchedule; readonly schedule: TimeSchedule }

const decodedDays = (
  days: TriggerDays
): { readonly stored: TriggerDays; readonly weekdays: Weekdays } | undefined => {
  switch (days.kind) {
    case TRIGGER_STATE.every_day:
      return { stored: days, weekdays: EVERY_DAY }
    case TRIGGER_STATE.days: {
      const tokens = dayTokens(days.days.trim())
      return tokens === undefined
        ? undefined
        : { stored: { kind: "days", days: tokens.join(",") }, weekdays: weekdays(tokens) }
    }
  }
}

type DecodedWindow = {
  readonly stored: IntervalWindow
  readonly start: number
  readonly end: number
}

const decodedWindow = (window: IntervalWindow): DecodedWindow | undefined => {
  switch (window.kind) {
    case TRIGGER_STATE.all_day:
      return { stored: window, start: 0, end: MINUTES_PER_DAY }
    case TRIGGER_STATE.from: {
      const from = wallTime(window.start.trim())
      return from === undefined
        ? undefined
        : {
            stored: { kind: "from", start: formatWallTime(from) },
            start: minuteOfDay(from),
            end: MINUTES_PER_DAY
          }
    }
    case TRIGGER_STATE.until: {
      const to = wallTime(window.end.trim())
      return to === undefined
        ? undefined
        : { stored: { kind: "until", end: formatWallTime(to) }, start: 0, end: minuteOfDay(to) }
    }
    case TRIGGER_STATE.between: {
      const from = wallTime(window.start.trim())
      const to = wallTime(window.end.trim())
      return from === undefined || to === undefined || minuteOfDay(from) >= minuteOfDay(to)
        ? undefined
        : {
            stored: { kind: "between", start: formatWallTime(from), end: formatWallTime(to) },
            start: minuteOfDay(from),
            end: minuteOfDay(to)
          }
    }
  }
}

const decodeInterval = (
  schedule: Extract<TimeTriggerSchedule, { readonly kind: "interval" }>
): DecodedTime | undefined => {
  const every = schedule.every.trim()
  const minutes = parseIntervalMinutes(every)
  const days = decodedDays(schedule.days)
  const window = decodedWindow(schedule.window)
  if (minutes === undefined || days === undefined || window === undefined) return undefined
  return {
    stored: {
      kind: "interval",
      every: every.toLowerCase(),
      days: days.stored,
      window: window.stored
    },
    schedule: {
      kind: "interval",
      minutes,
      window: { start: window.start, end: window.end },
      days: days.weekdays
    }
  }
}

export const decodeTimeTrigger = (schedule: TimeTriggerSchedule): DecodedTime | undefined => {
  switch (schedule.kind) {
    case TRIGGER_STATE.interval:
      return decodeInterval(schedule)
    case TRIGGER_STATE.next: {
      const time = wallTime(schedule.at.trim())
      return time === undefined
        ? undefined
        : {
            stored: { kind: "next", at: formatWallTime(time) },
            schedule: { kind: "next", at: time }
          }
    }
    case TRIGGER_STATE.once: {
      const time = wallTime(schedule.at.trim())
      const on = schedule.on.trim()
      const date = parseCalendarDay(on)
      return time === undefined || date === undefined
        ? undefined
        : {
            stored: { kind: "once", at: formatWallTime(time), on },
            schedule: { kind: "once", on: date, at: time }
          }
    }
    case TRIGGER_STATE.daily: {
      const time = wallTime(schedule.at.trim())
      const tokens = dayTokens(schedule.days.trim())
      return time === undefined || tokens === undefined
        ? undefined
        : {
            stored: { kind: "daily", at: formatWallTime(time), days: tokens.join(",") },
            schedule: { kind: "daily", at: time, days: weekdays(tokens) }
          }
    }
  }
}

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

export const firstRunAt = (
  triggers: ReadonlyArray<AutomationTriggerSpec>,
  clock: ScheduleClock
): number | undefined => {
  if (triggers.length === 0) return undefined
  const times: Array<TimeSchedule> = []
  for (const trigger of triggers) {
    if (trigger.type !== TRIGGER_TYPE.time) return undefined
    const decoded = decodeTimeTrigger(trigger.schedule)
    if (decoded === undefined) return undefined
    times.push(decoded.schedule)
  }
  return nextScheduleRunAt(times, clock) ?? undefined
}

export const nextAutomationRunAt = (
  time: TimeSchedule,
  { afterMs, zone }: ScheduleClock
): number | null => {
  switch (time.kind) {
    case TRIGGER_STATE.once: {
      const fire = atWall(zone, time.on, time.at)
      return fire > afterMs ? fire : null
    }
    case TRIGGER_STATE.next:
      return nextDailyRunAt(time.at, EVERY_DAY, afterMs, zone)
    case TRIGGER_STATE.daily:
      return nextDailyRunAt(time.at, time.days, afterMs, zone)
    case TRIGGER_STATE.interval: {
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

export const automationRepeats = (triggers: unknown): boolean =>
  Option.getOrElse(decodeStoredTriggers(triggers), () => []).some((trigger) => {
    if (trigger.type !== TRIGGER_TYPE.time) return true
    const kind = decodeTimeTrigger(trigger.schedule)?.schedule.kind
    return kind === TRIGGER_STATE.daily || kind === TRIGGER_STATE.interval
  })
