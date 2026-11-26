import { isoDateTimeWords, parseCalendarDay } from "@arden-hq/std/time"
import { Option, Schema } from "effect"

import { allDayText } from "./google-calendar-events.js"
import type { MacAppsHelper } from "./mac-apps-helper.js"
import { toolRefusal } from "./tool-failure.js"

const text = Schema.optionalKey(Schema.String)

const CalendarRecordSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  writable: Schema.Boolean,
  default: Schema.Boolean,
  account: text
})
export type MacCalendarRecord = typeof CalendarRecordSchema.Type
export const CalendarListSchema = Schema.Array(CalendarRecordSchema)

export const EventRecordSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  all_day: Schema.Boolean,
  start: Schema.String,
  end: Schema.String,
  calendar: Schema.String,
  calendar_id: text,
  location: text,
  repeats: text,
  canceled: Schema.optionalKey(Schema.Boolean),
  guests: Schema.optionalKey(Schema.Number),
  has_notes: Schema.optionalKey(Schema.Boolean),
  notes: text,
  url: text,
  time_zone: text,
  organizer: text,
  alerts_minutes_before: Schema.optionalKey(Schema.Array(Schema.Number)),
  guest_list: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        answer: Schema.String,
        name: text,
        email: text,
        you: Schema.optionalKey(Schema.Boolean)
      })
    )
  )
})
export type MacEventRecord = typeof EventRecordSchema.Type

export const EventSearchSchema = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  events: Schema.Array(EventRecordSchema),
  more: Schema.Boolean
})

export const ReminderRecordSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  list: Schema.String,
  completed: Schema.Boolean,
  due: text,
  completed_at: text,
  priority: text,
  notes: text,
  url: text,
  repeats: text,
  note: text
})
export type MacReminderRecord = typeof ReminderRecordSchema.Type

export const ReminderSearchSchema = Schema.Struct({
  reminders: Schema.Array(ReminderRecordSchema),
  more: Schema.Boolean
})

const LabeledSchema = Schema.Array(Schema.Struct({ value: Schema.String, label: text }))

export const ContactRecordSchema = Schema.Struct({
  id: Schema.String,
  name: text,
  organization: text,
  emails: Schema.optionalKey(LabeledSchema),
  phones: Schema.optionalKey(LabeledSchema),
  nickname: text,
  job_title: text,
  department: text,
  birthday: text,
  addresses: Schema.optionalKey(LabeledSchema),
  links: Schema.optionalKey(LabeledSchema)
})
export type MacContactRecord = typeof ContactRecordSchema.Type

export const ContactSearchSchema = Schema.Struct({
  contacts: Schema.Array(ContactRecordSchema),
  more: Schema.Boolean
})

export const DeletedSchema = Schema.Struct({ deleted: Schema.String, title: Schema.String })

export const record = <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown
): S["Type"] => {
  const decoded = Schema.decodeUnknownOption(schema)(value)
  if (Option.isNone(decoded)) {
    throw toolRefusal(
      "The Mac's answer did not have the expected shape. Read the item again before you rely on it.",
      "Unexpected answer from the Mac"
    )
  }
  return decoded.value
}

const UNTITLED = "(no title)"
export const titleOf = (item: { readonly title: string }): string =>
  item.title === "" ? UNTITLED : item.title

const DAY = /^\d{4}-\d{2}-\d{2}$/u
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u
const NEGATIVE_OFFSET_SIGN = "-"
const OFFSET = /(?:Z|([+-])(\d{2}):(\d{2}))$/u

export const isDay = (value: string): boolean => DAY.test(value)

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC"
})

export type TimeWords = (value: string) => string

export interface MacApps {
  readonly helper: MacAppsHelper
  readonly words: TimeWords
  readonly clock: LocalClock
}

export interface LocalClock {
  readonly instant: (time: string) => number
  readonly localTime: (at: number) => string
}

export type OffsetMinutes = (at: Date) => number
const machineOffsetMinutes: OffsetMinutes = (at) => -at.getTimezoneOffset()

export const makeLocalClock = (
  offsetMinutes: OffsetMinutes = machineOffsetMinutes
): LocalClock => ({
  instant: (time) => {
    if (!LOCAL_TIME.test(time)) return Date.parse(time)
    const wall = Date.parse(`${time}Z`)
    return wall - offsetMinutes(new Date(wall)) * 60_000
  },
  localTime: (at) => new Date(at + offsetMinutes(new Date(at)) * 60_000).toISOString().slice(0, 16)
})

export const makeTimeWords =
  (offsetMinutes: OffsetMinutes = machineOffsetMinutes): TimeWords =>
  (value) => {
    if (isDay(value)) {
      return parseCalendarDay(value) === undefined
        ? value
        : DAY_FORMAT.format(new Date(`${value}T12:00:00Z`))
    }
    if (LOCAL_TIME.test(value)) return withoutZone(isoDateTimeWords(`${value}Z`))
    const words = isoDateTimeWords(value)
    const offset = OFFSET.exec(value)
    if (words === value || offset === null) return words
    const minutes =
      offset[1] === undefined
        ? 0
        : (offset[1] === NEGATIVE_OFFSET_SIGN ? -1 : 1) *
          (Number(offset[2]) * 60 + Number(offset[3]))
    return minutes === offsetMinutes(new Date(value)) ? withoutZone(words) : words
  }

const withoutZone = (words: string): string => words.replace(/ \(UTC[^)]*\)$/u, "")

export const eventTimeFields = (
  item: { readonly start: string; readonly end: string | undefined; readonly all_day: boolean },
  words: TimeWords
): ReadonlyArray<{ readonly label: string; readonly value: string }> => {
  if (item.all_day) {
    const days = { start: item.start, end: item.end ?? item.start, all_day: true }
    return [{ label: "When", value: allDayText(days) ?? item.start }]
  }
  return [
    { label: "Starts", value: words(item.start) },
    ...(item.end === undefined ? [] : [{ label: "Ends", value: words(item.end) }])
  ]
}

export const eventTimeLine = (item: MacEventRecord): string =>
  allDayText(item) ?? `${item.start} — ${item.end}`

const REPEAT_WORDS: Readonly<Record<string, string>> = {
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
  yearly: "Every year"
}

export const repeatWords = (rule: string): string =>
  Object.hasOwn(REPEAT_WORDS, rule) ? (REPEAT_WORDS[rule] ?? rule) : rule

export const alertWords = (minutes: number): string =>
  minutes === 0 ? "At the start" : `${minutes} min before`

export const calendarWords = (calendar: MacCalendarRecord): string =>
  calendar.account === undefined || calendar.account === calendar.title
    ? calendar.title
    : `${calendar.title} (${calendar.account})`
