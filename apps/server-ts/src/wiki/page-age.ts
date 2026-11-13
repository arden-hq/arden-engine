import { utcDay } from "@arden-hq/std/time"
import { countOf } from "@arden-hq/std/count"

import type { PageTimes } from "./timestamps.js"

const DAY_MS = 86_400_000

/**
 * How long ago a page last changed, for the model. A page's facts were true when written;
 * nothing on it is newer than its last change, so the age is the least a reader must allow for.
 * Counted in UTC calendar days, so it agrees with the day shown and holds for a whole day.
 */
export const changedAgo = (
  updatedAt: string | null | undefined,
  now: number
): string | undefined => {
  if (updatedAt === null || updatedAt === undefined) return undefined
  const at = new Date(updatedAt).getTime()
  if (!Number.isFinite(at)) return undefined
  const days = Math.max(0, Math.floor(now / DAY_MS) - Math.floor(at / DAY_MS))
  return days === 0 ? "today" : `${countOf(days, "day")} ago`
}

/** "Last changed: 2026-09-15 (59 days ago)", or nothing when the time is unknown. */
export const lastChangedLine = (
  updatedAt: string | null | undefined,
  now: number
): string | undefined => {
  const ago = changedAgo(updatedAt, now)
  return ago === undefined || updatedAt === null || updatedAt === undefined
    ? undefined
    : `Last changed: ${utcDay(updatedAt)} (${ago})`
}

/** Every page's "Last changed" line, by page id. Pages with no known time are left out. */
export const lastChangedLines = (
  times: ReadonlyMap<string, PageTimes>,
  now: number
): ReadonlyMap<string, string> =>
  new Map(
    [...times].flatMap(([pageId, { updatedAt }]) => {
      const line = lastChangedLine(updatedAt, now)
      return line === undefined ? [] : [[pageId, line] as const]
    })
  )

/** What the age means, said once wherever pages are shown with it. */
export const PAGE_AGE_RULE =
  "Nothing on a page is newer than its last change. A status, plan, price or date on it may have moved since: when that matters to the answer, say as of when, or check with a tool."
