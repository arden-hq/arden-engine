// The "sent" score of the memory test: was the page that holds the answer in what a new chat
// was sent from Memory? Pure: it reads the run's record of what it was sent, the one record
// `prefetchTurnMemory` writes for every run, and calls nothing.

import type { RunMemoryContext, RunMemorySource } from "@arden-hq/protocol/runs"
import { QUESTION_KINDS, type Question, type QuestionKind } from "./questions.js"

/** The route a page reached the chat by: standing facts, recall or the Space context. */
export type Via = "core" | "recall" | "space"

export interface Placed {
  readonly path: string
  readonly via: Via
  /** False when the page reached the chat only in part: cut by its renderer, or a passage. */
  readonly whole: boolean
}

export interface Delivery {
  /** Pages whose rendered block reached the chat. A page named only in the index is not
   * here. */
  readonly pages: ReadonlyArray<Placed>
  /** Pages left out for lack of room in their source's allowance. */
  readonly cut: ReadonlyArray<Placed>
  /** Everything the chat was sent from Memory and its Space. */
  readonly text: string
  /** Bytes sent, by route and for the index, as the record counts them. */
  readonly bytes: Readonly<Record<Via | "index", number>>
}

const viaOf = (source: Exclude<RunMemorySource, { readonly kind: "index" }>): Via => {
  switch (source.kind) {
    case "core":
      return "core"
    case "recalled":
      return "recall"
    case "space":
      return "space"
  }
}

/**
 * What a new chat was sent, read from one composition of its run's record. A page reached the
 * chat unless its source's allowance had no room for it.
 */
export const deliveryOf = ({
  composition,
  paths,
  text
}: {
  readonly composition: RunMemoryContext
  /** The path of each page the composition names, by page id. */
  readonly paths: ReadonlyMap<string, string>
  /** The text of the sections the chat was sent from Memory and its Space. */
  readonly text: string
}): Delivery => {
  const pages: Array<Placed> = []
  const cut: Array<Placed> = []
  const bytes: Record<Via | "index", number> = { core: 0, recall: 0, space: 0, index: 0 }
  for (const source of composition.sources) {
    if (source.kind === "index") {
      bytes.index += source.bytes
      continue
    }
    const via = viaOf(source)
    bytes[via] += source.bytes
    if (source.page_id === null) continue
    const path = paths.get(source.page_id)
    if (path === undefined) throw new Error("A recorded Memory page has no path on the copy")
    const placed = { path, via, whole: source.outcome === "whole" }
    if (source.outcome !== "dropped") pages.push(placed)
    else cut.push(placed)
  }
  return { pages, cut, text, bytes }
}

export interface SentResult {
  readonly id: string
  readonly kind: QuestionKind
  readonly space_id: string | null
  readonly sent: boolean
  /** Expected pages that did not reach the chat. */
  readonly missing: ReadonlyArray<string>
  /** Expected pages left out for lack of room in their source's allowance. */
  readonly cut: ReadonlyArray<string>
  /** Expected pages that reached the chat only in part, cut short by their renderer. Whether
   * the answer lies in the part sent is not checked: the answered score judges that. */
  readonly inPart: ReadonlyArray<string>
  /** For a question with no answer: the misleading patterns found in what was sent. */
  readonly misleading: ReadonlyArray<string>
  readonly pages: Delivery["pages"]
  readonly budgetCut: Delivery["cut"]
  readonly bytes: Delivery["bytes"]
}

/**
 * Sent: every expected page reached the chat. For a question with no answer in Memory: nothing
 * misleading did.
 */
export const scoreSent = (question: Question, delivery: Delivery): SentResult => {
  const delivered = new Set(delivery.pages.map((page) => page.path))
  const deliveredWhole = new Set(
    delivery.pages.filter((page) => page.whole).map((page) => page.path)
  )
  const cutPaths = new Set(delivery.cut.map((page) => page.path))
  const missing = question.expected_pages.filter((path) => !delivered.has(path))
  const misleading =
    question.kind === "no_answer"
      ? question.misleading.filter((pattern) => new RegExp(pattern, "iu").test(delivery.text))
      : []
  return {
    id: question.id,
    kind: question.kind,
    space_id: question.space_id,
    sent: missing.length === 0 && misleading.length === 0,
    missing,
    cut: missing.filter((path) => cutPaths.has(path)),
    inPart: question.expected_pages.filter(
      (path) => delivered.has(path) && !deliveredWhole.has(path)
    ),
    misleading,
    pages: delivery.pages,
    budgetCut: delivery.cut,
    bytes: delivery.bytes
  }
}

export interface KindCount {
  readonly kind: QuestionKind
  readonly questions: number
  readonly sent: number
  /** Of the questions sent, those where an expected page reached the chat only in part. */
  readonly inPart: number
  /** Of the questions not sent, those where an expected page was left out for room. */
  readonly cut: number
}

/** Counts by kind, every kind in its fixed order, then a total row. */
export const countByKind = (
  results: ReadonlyArray<SentResult>
): ReadonlyArray<KindCount | (Omit<KindCount, "kind"> & { readonly kind: "total" })> => {
  const count = (rows: ReadonlyArray<SentResult>) => ({
    questions: rows.length,
    sent: rows.filter((row) => row.sent).length,
    inPart: rows.filter((row) => row.sent && row.inPart.length > 0).length,
    cut: rows.filter((row) => !row.sent && row.cut.length > 0).length
  })
  return [
    ...QUESTION_KINDS.map((kind) => ({
      kind,
      ...count(results.filter((row) => row.kind === kind))
    })),
    { kind: "total" as const, ...count(results) }
  ]
}

/** The printed table: counts only, never a question or an answer. */
export const renderCountTable = (results: ReadonlyArray<SentResult>): string => {
  const rows = countByKind(results)
  const header = ["kind", "questions", "sent", "sent in part", "not sent", "left out for room"]
  const body = rows.map((row) => [
    row.kind,
    String(row.questions),
    String(row.sent),
    String(row.inPart),
    String(row.questions - row.sent),
    String(row.cut)
  ])
  const widths = header.map((title, column) =>
    Math.max(title.length, ...body.map((cells) => cells[column]?.length ?? 0))
  )
  const line = (cells: ReadonlyArray<string>) =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ")
  return [line(header), ...body.map(line)].join("\n")
}

const LEVEL_NAMES = ["not sent", "sent in part", "sent whole"] as const

/** How fully a page was sent, read from its question's result. */
const pageLevel = (result: Pick<SentResult, "missing" | "inPart">, path: string): 0 | 1 | 2 => {
  if (result.missing.includes(path)) return 0
  return result.inPart.includes(path) ? 1 : 2
}

export interface Regression {
  readonly id: string
  readonly path: string
  readonly was: (typeof LEVEL_NAMES)[number]
  readonly now: (typeof LEVEL_NAMES)[number]
}

/**
 * Expected pages sent less fully than in a baseline run, page by page: whole to in part, or
 * whole or in part to not sent. A page missing or in part now was expected then too.
 */
export const regressionsFrom = (
  baseline: ReadonlyArray<Pick<SentResult, "id" | "missing" | "inPart">>,
  results: ReadonlyArray<SentResult>
): ReadonlyArray<Regression> => {
  const before = new Map(baseline.map((result) => [result.id, result] as const))
  return results.flatMap((result) => {
    const was = before.get(result.id)
    if (was === undefined) return []
    return [...result.missing, ...result.inPart].flatMap((path) => {
      const then = pageLevel(was, path)
      const now = pageLevel(result, path)
      return now >= then
        ? []
        : [{ id: result.id, path, was: LEVEL_NAMES[then], now: LEVEL_NAMES[now] }]
    })
  })
}
