import { splitAttachedFiles } from "@arden-hq/protocol/chat"

export const SNIPPET_OPEN = "\u0002"
export const SNIPPET_CLOSE = "\u0003"

const LEAD_CHARS = 24
const MAX_CHARS = 160

export interface FindSnippet {
  readonly text: string
  readonly ranges: ReadonlyArray<readonly [start: number, end: number]>
}

export const findSnippet = (marked: string): FindSnippet => {
  const flat = marked
    .replace(/```[\w-]*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
  let text = ""
  const ranges: Array<readonly [number, number]> = []
  let open: number | undefined
  for (const char of flat) {
    if (char === SNIPPET_OPEN) open = text.length
    else if (char === SNIPPET_CLOSE) {
      if (open !== undefined && text.length > open) ranges.push([open, text.length])
      open = undefined
    } else text += char
  }
  const first = ranges[0]?.[0] ?? 0
  let start = 0
  if (first > LEAD_CHARS) {
    const space = text.indexOf(" ", first - LEAD_CHARS)
    start = space >= 0 && space < first ? space + 1 : first - LEAD_CHARS
  }
  const end = Math.min(text.length, Math.max(start + MAX_CHARS, ranges[0]?.[1] ?? 0))
  const lead = start > 0 ? "…" : ""
  const tail = end < text.length ? "…" : ""
  const shift = lead.length - start
  return {
    text: `${lead}${text.slice(start, end).trimEnd()}${tail}`,
    ranges: ranges
      .filter(([from, to]) => from >= start && to <= end)
      .map(([from, to]) => [from + shift, to + shift] as const)
  }
}

const MARKS = new RegExp(`[${SNIPPET_OPEN}${SNIPPET_CLOSE}]`, "gu")

export const snippetWithFileNames = (marked: string, searchText: string): string => {
  const { files } = splitAttachedFiles(searchText)
  if (files.length === 0) return marked
  const lines = files.map((file) => `Attached: ${file.path}${file.directory ? "/" : ""}`)
  const nameOf = (line: string): string | undefined => {
    const plain = line.replace(MARKS, "").replace(/^…/u, "").replace(/…$/u, "")
    if (!plain.includes("/") || !lines.some((full) => full.includes(plain))) return undefined
    const body = line.replace(/\/(?=[\u0002\u0003]*…?$)/u, "")
    return body.slice(body.lastIndexOf("/") + 1)
  }
  let out = ""
  let afterName = false
  marked.split("\n").forEach((line, index) => {
    const name = nameOf(line)
    if (index > 0) out += name !== undefined && afterName ? ", " : "\n"
    out += name ?? line
    afterName = name !== undefined
  })
  return out
}
