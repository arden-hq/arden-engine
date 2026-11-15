import { countOf } from "@arden-hq/std/count"
import { utcDay } from "@arden-hq/std/time"
import { DateTime, Effect } from "effect"

import type { Wiki } from "./service.js"
import type { PageTimes } from "./timestamps.js"

const DAY_MS = 86_400_000

/**
 * How long ago a page last changed, for the model. A page's facts were true when written;
 * nothing on it is newer than its last change, so the age is the least a reader must allow for.
 * Counted in UTC calendar days, so it agrees with the day shown and holds for a whole day.
 */
const changedAgo = (updatedAt: string | null | undefined, now: number): string | undefined => {
  if (updatedAt === null || updatedAt === undefined) return undefined
  const at = new Date(updatedAt).getTime()
  if (!Number.isFinite(at)) return undefined
  const days = Math.max(0, Math.floor(now / DAY_MS) - Math.floor(at / DAY_MS))
  return days === 0 ? "today" : `${countOf(days, "day")} ago`
}

/** "Last changed: 2026-09-15 (59 days ago)", or nothing when the time is unknown. */
const lastChangedLine = (updatedAt: string | null | undefined, now: number): string | undefined => {
  const ago = changedAgo(updatedAt, now)
  return ago === undefined || updatedAt === null || updatedAt === undefined
    ? undefined
    : `Last changed: ${utcDay(updatedAt)} (${ago})`
}

/**
 * How long ago each page last changed, as of a head. The age is extra: when history cannot be
 * read, pages are shown without it.
 */
export const loadPageAges = Effect.fn("Wiki.loadPageAges")(function* (
  wiki: Pick<Wiki["Service"], "pageTimes">,
  head: Parameters<Wiki["Service"]["pageTimes"]>[0]
) {
  const now = DateTime.toEpochMillis(yield* DateTime.now)
  const times = yield* wiki
    .pageTimes(head)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Memory page times unavailable", cause).pipe(
          Effect.as(new Map<string, PageTimes>())
        )
      )
    )
  return {
    /** Every page's "Last changed" line, by page id. Pages with no known time are left out. */
    lines: new Map(
      [...times].flatMap(([pageId, { updatedAt }]) => {
        const line = lastChangedLine(updatedAt, now)
        return line === undefined ? [] : [[pageId, line] as const]
      })
    ),
    ago: (pageId: string) => changedAgo(times.get(pageId)?.updatedAt, now)
  }
})

/** What the age means, said once wherever pages are shown with it. */
export const PAGE_AGE_RULE =
  "Nothing on a page is newer than its last change. A status, plan, price or date on it may have moved since: when that matters to the answer, say as of when, or check with a tool."
