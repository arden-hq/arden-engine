import { countOf } from "./count.js"

/** Whole-second duration words: "0s", "1m 26s", "2h 5m"; `units: 1` keeps the largest unit only ("2m", "1h") for compact rows. Each unit is picked after rounding, so 59.6 s reads "1m", never "60s". */
export const formatDuration = (ms: number, options: { readonly units?: 1 | 2 } = {}): string => {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (options.units === 1) return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`
  return minutes % 60 === 0
    ? `${Math.floor(minutes / 60)}h`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Fine duration for timings: "850ms", "4.2s", "10s", "2m", "2m 05s". Each unit is picked after rounding, so 59.95 s reads "1m", never "60.0s". */
export const formatDurationFine = (ms: number): string => {
  if (Math.round(ms) < 1000) return `${Math.round(ms)}ms`
  if (ms >= 3_600_000) return formatDuration(ms)
  const tenths = Math.round(ms / 100)
  if (tenths < 600) return `${(tenths / 10).toFixed(1).replace(/\.0$/u, "")}s`
  const seconds = Math.round(ms / 1000)
  const rest = seconds % 60
  return rest === 0
    ? `${Math.floor(seconds / 60)}m`
    : `${Math.floor(seconds / 60)}m ${String(rest).padStart(2, "0")}s`
}

interface SpanTier {
  readonly count: number
  readonly unit: "minute" | "hour" | "day" | "month"
}

const spanTier = (deltaMs: number): SpanTier => {
  const minutes = Math.max(1, Math.floor(deltaMs / 60_000))
  if (minutes < 60) return { count: minutes, unit: "minute" }
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return { count: hours, unit: "hour" }
  const days = Math.floor(hours / 24)
  if (days < 30) return { count: days, unit: "day" }
  return { count: Math.floor(days / 30), unit: "month" }
}

const COMPACT_UNIT = { minute: "m", hour: "h", day: "d", month: "mo" } as const

/** "12m", "3h", "2d", "5mo". */
export const compactSpan = (deltaMs: number): string => {
  const { count, unit } = spanTier(deltaMs)
  return `${count}${COMPACT_UNIT[unit]}`
}

/** "5 minutes", "1 hour", "2 days". */
export const spanWords = (deltaMs: number): string => {
  const { count, unit } = spanTier(deltaMs)
  return countOf(count, unit)
}

const instantMs = (value: string | number): number =>
  typeof value === "number" ? value : new Date(value).getTime()

/**
 * An instant against `now`: "now", "<1m", "3h ago", "in 3h". Empty for a value
 * that is not a date, never the raw text.
 */
export const relativeLabel = (value: string | number, now: number): string => {
  const at = instantMs(value)
  if (!Number.isFinite(at)) return ""
  const delta = at - now
  if (Math.abs(delta) < 60_000) return delta > 0 ? "<1m" : "now"
  return delta > 0 ? `in ${compactSpan(delta)}` : `${compactSpan(-delta)} ago`
}

/** `YYYY-MM-DD HH:MM UTC` for an instant; empty for a value that is not a date. */
export const utcStamp = (value: string | number): string => {
  const at = instantMs(value)
  if (!Number.isFinite(at)) return ""
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`
}

/** The UTC calendar day `YYYY-MM-DD` of an instant; empty for a value that is not a date. */
export const utcDay = (value: string | number): string => {
  const at = instantMs(value)
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : ""
}

/** A calendar day, not an instant. */
export interface CalendarDay {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** `YYYY-MM-DD` as a calendar day; undefined for anything else, including 2026-02-30. */
export const parseCalendarDay = (text: string): CalendarDay | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text)
  if (match === null) return undefined
  const day = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  const check = new Date(Date.UTC(day.year, day.month - 1, day.day))
  return check.getUTCFullYear() === day.year &&
    check.getUTCMonth() + 1 === day.month &&
    check.getUTCDate() === day.day
    ? day
    : undefined
}

/** The zone the machine runs in: what "local" means for a person using Arden on it. */
export const machineTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

/** The `YYYY-MM-DD` day an instant falls on in a zone; empty for a value that is not a date. */
export const localDayOf = (value: string | number, timeZone: string): string => {
  const at = instantMs(value)
  if (!Number.isFinite(at)) return ""
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(at)
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? ""
  return `${part("year")}-${part("month")}-${part("day")}`
}

const oneDecimal = (value: number): string => String(Math.round(value * 10) / 10)

const unitWords = (value: number, unit: string): string => {
  const text = oneDecimal(value)
  return `${text} ${text === "1" ? unit : `${unit}s`}`
}

/**
 * An age or gap for the model: whole minutes under an hour ("1 minute", "45
 * minutes"), hours under 48 ("1.5 hours", "2 hours"), then days likewise. A
 * decimal of .0 is dropped.
 */
export const ageWords = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return unitWords(Math.max(1, minutes), "minute")
  const hours = ms / 3_600_000
  return hours < 48 ? unitWords(hours, "hour") : unitWords(hours / 24, "day")
}

export interface ClockOptions {
  /** Names follow this locale; the OS locale when absent. */
  readonly locale?: Intl.LocalesArgument
  readonly timeZone?: string
}

const clockFormats = new Map<string, Intl.DateTimeFormat>()

const cachedFormat = (
  kind: string,
  options: ClockOptions,
  build: () => Intl.DateTimeFormat
): Intl.DateTimeFormat => {
  const key = `${kind}|${String(options.locale)}|${options.timeZone ?? ""}`
  let format = clockFormats.get(key)
  if (format === undefined) {
    format = build()
    clockFormats.set(key, format)
  }
  return format
}

const zoneOption = (options: ClockOptions): { timeZone?: string } =>
  options.timeZone === undefined ? {} : { timeZone: options.timeZone }

/** The one clock the app and the model read: 12-hour, "7:38 AM" (a plain space, not ICU's narrow one). */
export const formatClock = (at: number | Date, options: ClockOptions = {}): string =>
  cachedFormat(
    "clock",
    options,
    () =>
      new Intl.DateTimeFormat(options.locale, {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        ...zoneOption(options)
      })
  )
    .format(at)
    .replace(/[\u202f\u00a0]/gu, " ")

const dayKey = (at: number, options: ClockOptions): string =>
  localDayOf(at, options.timeZone ?? machineTimeZone())

const dayNumber = (key: string): number => {
  const [year, month, day] = key.split("-").map(Number)
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1) / 86_400_000
}

/**
 * The day an instant falls on, in the fewest words: "Today", "Tomorrow",
 * "Yesterday", the weekday within six days either way ("Fri"), else "Oct 3",
 * with the year when it is not this one.
 */
export const formatDayWord = (
  at: number | Date,
  now: number | Date,
  options: ClockOptions = {}
): string => {
  const atMs = at instanceof Date ? at.getTime() : at
  const nowMs = now instanceof Date ? now.getTime() : now
  const atKey = dayKey(atMs, options)
  const nowKey = dayKey(nowMs, options)
  const days = dayNumber(atKey) - dayNumber(nowKey)
  if (days === 0) return "Today"
  if (days === 1) return "Tomorrow"
  if (days === -1) return "Yesterday"
  if (Math.abs(days) < 7) {
    return cachedFormat(
      "weekday",
      options,
      () => new Intl.DateTimeFormat(options.locale, { weekday: "short", ...zoneOption(options) })
    ).format(atMs)
  }
  const sameYear = atKey.slice(0, 4) === nowKey.slice(0, 4)
  return cachedFormat(
    sameYear ? "date" : "dateYear",
    options,
    () =>
      new Intl.DateTimeFormat(options.locale, {
        month: "short",
        day: "numeric",
        ...(sameYear ? {} : { year: "numeric" }),
        ...zoneOption(options)
      })
  ).format(atMs)
}

/** "Today 9:00 AM", "Fri 6:00 PM", "Oct 3, 9:00 AM": a day word and the clock. */
export const formatDayClock = (
  at: number | Date,
  now: number | Date,
  options: ClockOptions = {}
): string => {
  const days = Math.abs(
    dayNumber(dayKey(at instanceof Date ? at.getTime() : at, options)) -
      dayNumber(dayKey(now instanceof Date ? now.getTime() : now, options))
  )
  const separator = days >= 7 ? ", " : " "
  return `${formatDayWord(at, now, options)}${separator}${formatClock(at, options)}`
}

/**
 * Day words read after a label, inside a sentence: "Today 9:00 AM" becomes
 * "today 9:00 AM", "Yesterday" becomes "yesterday"; "Fri 6:00 PM" and "Oct 3"
 * stay as they are.
 */
export const dayWordsInSentence = (words: string): string =>
  /^(Today|Tomorrow|Yesterday)\b/u.test(words)
    ? words.charAt(0).toLowerCase() + words.slice(1)
    : words

/**
 * A stored wall time ("09:00", "24:00" for the end of the day) as the clock
 * words show it: "9:00 AM", "midnight". Anything else comes back as given.
 */
export const wallClockWords = (text: string): string => {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(text.trim())
  if (match === null) return text
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour === 24 && minute === 0) return "midnight"
  if (hour > 23 || minute > 59) return text
  return `${hour % 12 === 0 ? 12 : hour % 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`
}

/** An explicit-offset timestamp in words, preserving its wall time and precision. */
export const isoDateTimeWords = (text: string): string => {
  const parts =
    /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u.exec(
      text
    )
  if (
    parts === null ||
    parseCalendarDay(parts[1] ?? "") === undefined ||
    !Number.isFinite(Date.parse(text))
  )
    return text
  const day = new Date(`${parts[1]}T12:00:00Z`)
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(day)
  const hour = Number(parts[2])
  const seconds =
    parts[4] === undefined || (parts[4] === "00" && parts[5] === undefined)
      ? ""
      : `:${parts[4]}${parts[5] ?? ""}`
  const zone = parts[6] === "Z" ? "UTC" : `UTC${parts[6]}`
  return `${date}, ${hour % 12 || 12}:${parts[3]}${seconds} ${hour < 12 ? "AM" : "PM"} (${zone})`
}
