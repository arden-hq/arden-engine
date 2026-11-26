import { countOf } from "@arden-hq/std/count"
import { Option, Schema } from "effect"
import { pathToFileURL } from "node:url"

import { bodyFields } from "./code-mode-result.js"
import { readTextPage } from "./read-text.js"
import type { ServerRunContext } from "./run-context.js"
import { selectText } from "./text-select.js"
import { decodeOpaque, encodeOpaque } from "../lib/opaque-ref.js"
import { toolRefusal } from "./tool-failure.js"
import {
  MAX_DISCOVERY_ENTRIES,
  ReadParametersSchema,
  SEARCH_OUTPUT_MODE,
  type SearchOutputMode
} from "./files-read-parameters.js"

export const offerPage = (
  ctx: { readonly toolCallId: string; readonly run: ServerRunContext },
  source: string,
  window: { readonly offset: number; readonly limit: number }
): void =>
  ctx.run.codeMode.scriptFields(ctx.toolCallId, () =>
    bodyFields(readTextPage(source, { ...window, format: "plain" }).content)
  )

export const renderRead = (
  text: string,
  input: Schema.Schema.Type<typeof ReadParametersSchema>
): {
  readonly result: string
  readonly preview: string
  readonly total_lines: number
  readonly has_more: boolean
  readonly matches?: number
} => {
  if (input.grep !== undefined) {
    const selected = selectText(text, input)
    return {
      result: selected.text,
      preview: `${countOf(selected.matches, "matching line")} of ${selected.lines}`,
      total_lines: selected.lines,
      has_more: selected.truncated,
      matches: selected.matches
    }
  }
  const rendered = readTextPage(text, {
    ...input,
    format: input.line_numbers ? "numbered" : "plain"
  })
  return {
    result: rendered.notice ? `${rendered.content}\n\n${rendered.notice}` : rendered.content,
    preview: `Read ${rendered.shown} of ${rendered.total} lines`,
    total_lines: rendered.total,
    has_more: rendered.hasMore
  }
}

const PageCursorSchema = Schema.Struct({
  version: Schema.Literal(1),
  offset: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(MAX_DISCOVERY_ENTRIES)
  ),
  fingerprint: Schema.String
})

export const encodeCursor = (offset: number, fingerprint: string): string =>
  encodeOpaque({ version: 1, offset, fingerprint })

export const decodeCursor = (cursor: string | undefined, fingerprint: string): number => {
  if (cursor === undefined) return 0
  const value = Option.getOrUndefined(decodeOpaque(PageCursorSchema, cursor))
  if (value === undefined || value.fingerprint !== fingerprint) {
    throw toolRefusal(
      "The pagination cursor is invalid or belongs to another request.",
      "Invalid cursor"
    )
  }
  return value.offset
}

export const entryKind = (entry: {
  readonly isDirectory: () => boolean
  readonly isFile: () => boolean
}): string => {
  if (entry.isDirectory()) return "directory"
  if (entry.isFile()) return "file"
  return "other"
}

export const MAX_FOUND_SOURCES = 50

export const UNREADABLE_NOTE = "Some paths could not be read and were skipped."

export type FoundSource = {
  readonly provider: string
  readonly kind: string
  readonly ref: string
  readonly title: string
  readonly use: "found"
  readonly href: string
}

export const foundSource = (absolute: string, title: string): FoundSource => ({
  provider: "file",
  kind: "file",
  ref: absolute,
  title,
  use: "found" as const,
  href: pathToFileURL(absolute).href
})

export const renderSearchRecord = (
  record: Readonly<Record<string, string | number | boolean>>,
  mode: SearchOutputMode
): string => {
  if (mode === SEARCH_OUTPUT_MODE.content) {
    return `${record.relative_path}:${record.line}:${record.column}: ${record.snippet}`
  }
  if (mode === SEARCH_OUTPUT_MODE.count) return `${record.relative_path}: ${record.count}`
  return String(record.relative_path)
}
