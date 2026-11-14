// The "sent" score of the memory test: was the page that holds the answer in what a new chat
// was sent from Memory? Pure: it reads what `prefetchTurnMemory` returned, and calls nothing.

import { pageLine } from "../../src/memory/retrieval.js"
import { QUESTION_KINDS, type Question, type QuestionKind } from "./questions.js"

/** The part of `prefetchTurnMemory`'s result that says what was sent. */
export interface PrefetchedMemory {
  readonly space:
    | { readonly view: { readonly page: { readonly path: string } | undefined } }
    | undefined
  readonly spaceRender:
    | { readonly text: string; readonly page: "whole" | "partial" | "absent" }
    | undefined
  readonly recall:
    | {
        readonly core: string | null
        readonly text: string | null
        readonly sources: ReadonlyArray<{ readonly path: string }>
      }
    | undefined
  readonly continuity: {
    readonly sources: ReadonlyArray<{
      readonly kind: string
      readonly content: string
      readonly truncated: boolean
    }>
    readonly telemetry: { readonly outputBytes: number; readonly truncatedBytes: number }
  }
}

/**
 * Core Memory is sent whole and outside the budget; recall and the Space page share the budget.
 * A Space page longer than its share is sent in part, from the top.
 */
export type Via = "core" | "recall" | "space" | "space_partial"

export interface Delivery {
  /** Pages whose text, whole or in part, reached the chat. A page named only in a collection
   * line is not here. */
  readonly pages: ReadonlyArray<{ readonly path: string; readonly via: Via }>
  /** Pages that were rendered for the chat and then cut by the continuity budget. */
  readonly cut: ReadonlyArray<{ readonly path: string; readonly via: Via }>
  /** Everything the chat was sent from Memory and its Space. */
  readonly text: string
  readonly bytes: { readonly core: number; readonly budgeted: number; readonly cut: number }
}

const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).byteLength

const lines = (text: string | null | undefined): ReadonlySet<string> =>
  new Set((text ?? "").split("\n"))

/** What a new chat was sent, read from the prefetch result. */
export const deliveryOf = (prefetched: PrefetchedMemory): Delivery => {
  const core = prefetched.recall?.core ?? ""
  const kept = (kind: string) =>
    prefetched.continuity.sources.find((source) => source.kind === kind)
  const keptRecall = kept("recall")
  const keptSpace = kept("session")
  const coreLines = lines(core)
  const renderedLines = lines(prefetched.recall?.text)
  const keptLines = lines(keptRecall?.content)
  const pages: Array<{ readonly path: string; readonly via: Via }> = []
  const cut: Array<{ readonly path: string; readonly via: Via }> = []
  const seen = new Set<string>()
  for (const { path } of prefetched.recall?.sources ?? []) {
    if (seen.has(path)) continue
    seen.add(path)
    const line = pageLine(path)
    if (coreLines.has(line)) pages.push({ path, via: "core" })
    else if (keptLines.has(line)) pages.push({ path, via: "recall" })
    else if (renderedLines.has(line)) cut.push({ path, via: "recall" })
  }
  const spacePage = prefetched.space?.view.page?.path
  const spaceShare = prefetched.spaceRender?.page ?? "absent"
  if (spacePage !== undefined && spaceShare !== "absent") {
    const via = spaceShare === "whole" ? "space" : "space_partial"
    if (keptSpace !== undefined && !keptSpace.truncated) pages.push({ path: spacePage, via })
    else cut.push({ path: spacePage, via })
  }
  const budgeted = prefetched.continuity.sources.map((source) => source.content)
  return {
    pages,
    cut,
    text: [core, ...budgeted].join("\n\n"),
    bytes: {
      core: byteLength(core),
      budgeted: prefetched.continuity.telemetry.outputBytes,
      cut: prefetched.continuity.telemetry.truncatedBytes
    }
  }
}

export interface SentResult {
  readonly id: string
  readonly kind: QuestionKind
  readonly space_id: string | null
  readonly sent: boolean
  /** Expected pages that did not reach the chat. */
  readonly missing: ReadonlyArray<string>
  /** Expected pages the budget cut. */
  readonly cut: ReadonlyArray<string>
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
  /** Of the questions not sent, those where the budget cut an expected page. */
  readonly cut: number
}

/** Counts by kind, every kind in its fixed order, then a total row. */
export const countByKind = (
  results: ReadonlyArray<SentResult>
): ReadonlyArray<KindCount | (Omit<KindCount, "kind"> & { readonly kind: "total" })> => {
  const count = (rows: ReadonlyArray<SentResult>) => ({
    questions: rows.length,
    sent: rows.filter((row) => row.sent).length,
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
  const header = ["kind", "questions", "sent", "not sent", "cut by budget"]
  const body = rows.map((row) => [
    row.kind,
    String(row.questions),
    String(row.sent),
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
