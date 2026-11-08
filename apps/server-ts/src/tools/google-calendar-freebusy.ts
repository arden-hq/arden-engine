import { Schema } from "effect"

import { nextWallDay, wallDayOf, wallInstant, type WallDay } from "../google/zoned-time.js"
import { decodeGoogle } from "./google-request.js"

export interface BusyBlock {
  readonly start: number
  readonly end: number
}

export type CalendarBusy =
  | { readonly kind: "known"; readonly id: string; readonly busy: ReadonlyArray<BusyBlock> }
  | { readonly kind: "unknown"; readonly id: string; readonly reason: string }

const FreeBusyResponseSchema = Schema.Struct({
  calendars: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        errors: Schema.optionalKey(
          Schema.Array(Schema.Struct({ reason: Schema.optionalKey(Schema.String) }))
        ),
        busy: Schema.optionalKey(
          Schema.Array(Schema.Struct({ start: Schema.String, end: Schema.String }))
        )
      })
    )
  )
})

export const decodeFreeBusy = decodeGoogle(FreeBusyResponseSchema, {
  service: "calendar",
  label: "free/busy answer"
})

export const readFreeBusy = (
  response: ReturnType<typeof decodeFreeBusy>,
  requested: ReadonlyArray<string>
): ReadonlyArray<CalendarBusy> =>
  requested.map((id): CalendarBusy => {
    const entry = response.calendars?.[id]
    if (entry === undefined)
      return { kind: "unknown", id, reason: "Google returned nothing for it" }
    const [error] = entry.errors ?? []
    if (error !== undefined) return { kind: "unknown", id, reason: error.reason ?? "error" }
    if (entry.busy === undefined)
      return { kind: "unknown", id, reason: "Google returned no busy list" }
    const busy: Array<BusyBlock> = []
    for (const block of entry.busy) {
      const start = Date.parse(block.start)
      const end = Date.parse(block.end)
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return { kind: "unknown", id, reason: "unreadable busy time" }
      }
      if (end <= start) return { kind: "unknown", id, reason: "invalid busy interval" }
      busy.push({ start, end })
    }
    return { kind: "known", id, busy: mergeBlocks(busy) }
  })

const mergeBlocks = (blocks: ReadonlyArray<BusyBlock>): ReadonlyArray<BusyBlock> => {
  const merged: Array<BusyBlock> = []
  for (const block of [...blocks].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1]
    if (last !== undefined && block.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, block.end) }
    } else {
      merged.push(block)
    }
  }
  return merged
}

export interface SlotQuery {
  readonly windowStart: number
  readonly windowEnd: number
  readonly durationMs: number
  readonly workStartMinute: number
  readonly workEndMinute: number
  readonly timeZone: string
  readonly weekdaysOnly: boolean
  readonly limit: number
}

export const parseClockMinute = (value: string): number | undefined => {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value)
  if (match === null) return undefined
  const minute = Number(match[1]) * 60 + Number(match[2])
  return Number(match[2]) < 60 && minute <= 24 * 60 ? minute : undefined
}

export const findFreeSlots = (
  busy: ReadonlyArray<ReadonlyArray<BusyBlock>>,
  query: SlotQuery
): ReadonlyArray<BusyBlock> => {
  const taken = mergeBlocks(busy.flat())
  const slots: Array<BusyBlock> = []
  let day: WallDay = wallDayOf(query.windowStart, query.timeZone)
  for (let step = 0; step < 64 && slots.length < query.limit; step += 1) {
    const dayStart = wallInstant(day, 0, query.timeZone)
    if (dayStart >= query.windowEnd) break
    const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay()
    if (!query.weekdaysOnly || (weekday !== 0 && weekday !== 6)) {
      let cursor = Math.max(
        wallInstant(day, query.workStartMinute, query.timeZone),
        query.windowStart
      )
      const close = Math.min(wallInstant(day, query.workEndMinute, query.timeZone), query.windowEnd)
      for (const block of taken) {
        if (block.end <= cursor) continue
        if (block.start >= close) break
        if (block.start - cursor >= query.durationMs) {
          slots.push({ start: cursor, end: block.start })
        }
        cursor = Math.max(cursor, block.end)
      }
      if (close - cursor >= query.durationMs) slots.push({ start: cursor, end: close })
    }
    day = nextWallDay(day)
  }
  return slots.slice(0, query.limit)
}
