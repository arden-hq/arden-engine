import { countOf } from "./count.js"

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

const SPAN_UNIT = { minute: "minute", hour: "hour", day: "day", month: "month" } as const

type SpanUnit = (typeof SPAN_UNIT)[keyof typeof SPAN_UNIT]

interface SpanTier {
  readonly count: number
  readonly unit: SpanUnit
}

const spanTier = (deltaMs: number): SpanTier => {
  const minutes = Math.max(1, Math.floor(deltaMs / 60_000))
  if (minutes < 60) return { count: minutes, unit: SPAN_UNIT.minute }
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return { count: hours, unit: SPAN_UNIT.hour }
  const days = Math.floor(hours / 24)
  if (days < 30) return { count: days, unit: SPAN_UNIT.day }
  return { count: Math.floor(days / 30), unit: SPAN_UNIT.month }
}

const COMPACT_UNIT: Record<SpanUnit, string> = { minute: "m", hour: "h", day: "d", month: "mo" }

export const compactSpan = (deltaMs: number): string => {
  const { count, unit } = spanTier(deltaMs)
  return `${count}${COMPACT_UNIT[unit]}`
}

export const spanWords = (deltaMs: number): string => {
  const { count, unit } = spanTier(deltaMs)
  return countOf(count, unit)
}

const instantMs = (value: string | number): number =>
  typeof value === "number" ? value : new Date(value).getTime()

export const relativeLabel = (value: string | number, now: number): string => {
  const at = instantMs(value)
  if (!Number.isFinite(at)) return ""
  const delta = at - now
  if (Math.abs(delta) < 60_000) return delta > 0 ? "<1m" : "now"
  return delta > 0 ? `in ${compactSpan(delta)}` : `${compactSpan(-delta)} ago`
}

export const utcStamp = (value: string | number): string => {
  const at = instantMs(value)
  if (!Number.isFinite(at)) return ""
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`
}

export const utcDay = (value: string | number): string => {
  const at = instantMs(value)
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : ""
}

export interface CalendarDay {
  readonly year: number
  readonly month: number
  readonly day: number
}

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

export const machineTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

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

const unitWords = (value: number, unit: string): string => {
  const rounded = Math.round(value * 10) / 10
  return `${rounded} ${rounded === 1 ? unit : `${unit}s`}`
}

export const ageWords = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return unitWords(Math.max(1, minutes), "minute")
  const hours = ms / 3_600_000
  return hours < 48 ? unitWords(hours, "hour") : unitWords(hours / 24, "day")
}

export interface ClockOptions {
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

const ICU_NARROW_AND_NO_BREAK_SPACES = /[\u202f\u00a0]/gu

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
    .replace(ICU_NARROW_AND_NO_BREAK_SPACES, " ")

const dayKey = (at: number, options: ClockOptions): string =>
  localDayOf(at, options.timeZone ?? machineTimeZone())

const dayNumber = (key: string): number => {
  const [year, month, day] = key.split("-").map(Number)
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1) / 86_400_000
}

export const DAY_WORD = { today: "Today", tomorrow: "Tomorrow", yesterday: "Yesterday" } as const

export type DayWord = (typeof DAY_WORD)[keyof typeof DAY_WORD]

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
  if (days === 0) return DAY_WORD.today
  if (days === 1) return DAY_WORD.tomorrow
  if (days === -1) return DAY_WORD.yesterday
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

export const dayWordsInSentence = (words: string): string =>
  /^(Today|Tomorrow|Yesterday)\b/u.test(words)
    ? words.charAt(0).toLowerCase() + words.slice(1)
    : words

export const wallClockWords = (text: string): string => {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(text.trim())
  if (match === null) return text
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour === 24 && minute === 0) return "midnight"
  if (hour > 23 || minute > 59) return text
  return `${hour % 12 === 0 ? 12 : hour % 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`
}

export const isoDateTimeWords = (text: string): string => {
  const parts =
    /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(\.\d+)?)?(?:Z|([+-]\d{2}:\d{2}))$/u.exec(
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
    parts[4] === undefined || (Number(parts[4]) === 0 && parts[5] === undefined)
      ? ""
      : `:${parts[4]}${parts[5] ?? ""}`
  const zone = parts[6] === undefined ? "UTC" : `UTC${parts[6]}`
  return `${date}, ${hour % 12 || 12}:${parts[3]}${seconds} ${hour < 12 ? "AM" : "PM"} (${zone})`
}
