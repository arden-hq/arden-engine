/** The longest query a find box sends: a find is a few words, not a page. */
export const FIND_QUERY_MAX_LENGTH = 200

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g

/** Where `query` occurs in `text`: literal, case-insensitive, non-overlapping,
 *  as [start, end) offsets into `text` itself. The server counts a chat's
 *  matches and the desktop paints them with this one rule, so the count a
 *  find box shows and the marks it steps through agree. Case folding goes
 *  through the regular expression engine, never `toLowerCase`: lower-casing
 *  can change a string's length ("İ"), and offsets taken from the lowered copy
 *  would point into the wrong place of the original. A blank query matches
 *  nothing. */
export function findTextRanges(
  text: string,
  query: string
): ReadonlyArray<readonly [start: number, end: number]> {
  const needle = query.trim()
  if (needle.length === 0 || text.length === 0) return []
  const pattern = new RegExp(needle.replace(REGEXP_SPECIAL, "\\$&"), "giu")
  const ranges: Array<readonly [number, number]> = []
  for (const match of text.matchAll(pattern))
    ranges.push([match.index, match.index + match[0].length])
  return ranges
}
