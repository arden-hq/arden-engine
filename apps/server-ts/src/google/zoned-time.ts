import { parseCalendarDay, type CalendarDay } from "@arden-hq/std/time"
import { DateTime, Option } from "effect"

export type WallDay = CalendarDay

export const isTimeZone = (name: string): boolean => Option.isSome(DateTime.zoneFromString(name))

export const wallDayOf = (ms: number, timeZone: string): WallDay & { readonly weekday: number } => {
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(ms, { timeZone }))
  return { year: parts.year, month: parts.month, day: parts.day, weekday: parts.weekDay }
}

export const nextWallDay = (day: WallDay): WallDay => {
  const next = new Date(Date.UTC(day.year, day.month - 1, day.day + 1))
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
}

export const wallInstant = (day: WallDay, minutesOfDay: number, timeZone: string): number => {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day, 0, minutesOfDay))
  return DateTime.toEpochMillis(
    DateTime.makeZonedUnsafe(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes()
      },
      { timeZone, adjustForTimeZone: true }
    )
  )
}

const ALL_DAY_FIRE_MINUTE = 8 * 60

export const allDayFireAt = (date: string, timeZone: string): number | undefined => {
  const day = parseCalendarDay(date)
  return day === undefined ? undefined : wallInstant(day, ALL_DAY_FIRE_MINUTE, timeZone)
}
