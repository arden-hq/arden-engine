import { DateTime, Effect } from "effect"

import { changedAgo, lastChangedLine } from "../wiki/page-age.js"
import type { Wiki } from "../wiki/service.js"
import type { Snapshot } from "../wiki/snapshot.js"
import type { PageTimes } from "../wiki/timestamps.js"

/**
 * How long ago each page of a snapshot last changed, worded for a tool result. The age is extra:
 * when history cannot be read, pages are shown without it.
 */
export const loadPageAges = async (
  wiki: Pick<Wiki["Service"], "pageTimes">,
  snapshot: Snapshot,
  signal: AbortSignal
): Promise<{
  readonly line: (pageId: string) => string | undefined
  readonly ago: (pageId: string) => string | undefined
}> => {
  const times = await Effect.runPromise(
    wiki
      .pageTimes(snapshot.head)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Wiki page times unavailable", cause).pipe(
            Effect.as(new Map<string, PageTimes>())
          )
        )
      ),
    { signal }
  )
  const now = DateTime.toEpochMillis(DateTime.nowUnsafe())
  return {
    line: (pageId) => lastChangedLine(times.get(pageId)?.updatedAt, now),
    ago: (pageId) => changedAgo(times.get(pageId)?.updatedAt, now)
  }
}
