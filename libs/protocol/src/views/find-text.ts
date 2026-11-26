export const FIND_QUERY_MAX_LENGTH = 200

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g

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
