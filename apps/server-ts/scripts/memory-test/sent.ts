// The "sent" score of the memory test: was the page that holds the answer in what a new chat
// was sent from Memory? Pure: it reads what `prefetchTurnMemory` returned, and calls nothing.

import type { RenderedPage } from "../../src/memory/retrieval.js"
import { QUESTION_KINDS, type Question, type QuestionKind } from "./questions.js"

/** The part of `prefetchTurnMemory`'s result that says what was sent. */
export interface PrefetchedMemory {
  readonly spaceRender: { readonly page: RenderedPage | undefined } | undefined
  readonly recall:
    | { readonly core: string | null; readonly pages: ReadonlyArray<RenderedPage> }
    | undefined
  readonly continuity: {
    readonly sources: ReadonlyArray<{ readonly kind: string; readonly content: string }>
    readonly telemetry: { readonly outputBytes: number; readonly truncatedBytes: number }
  }
}

/** Core Memory is sent outside the budget; recall and the Space page share the budget. */
export type Via = "core" | "recall" | "space"

export interface Placed {
  readonly path: string
  readonly via: Via
  /** False when the renderer sent only part of the page, before any budget. */
  readonly whole: boolean
}

export interface Delivery {
  /** Pages whose rendered block reached the chat. A page named only in a collection line is
   * not here. */
  readonly pages: ReadonlyArray<Placed>
  /** Pages whose rendered block the continuity budget cut, in part or whole. */
  readonly cut: ReadonlyArray<Placed>
  /** Everything the chat was sent from Memory and its Space. */
  readonly text: string
  readonly bytes: { readonly core: number; readonly budgeted: number; readonly cut: number }
}

const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).byteLength

/**
 * What a new chat was sent, read from the prefetch result. One rule for every route: a page
 * reached the chat when its whole rendered block is in what was kept of its source; otherwise
 * the budget cut it.
 */
export const deliveryOf = (prefetched: PrefetchedMemory): Delivery => {
  const core = prefetched.recall?.core ?? ""
  const kept = (kind: string) =>
    prefetched.continuity.sources.find((source) => source.kind === kind)?.content ?? ""
  const spacePage = prefetched.spaceRender?.page
  const rendered = [
    ...(prefetched.recall?.pages ?? []).map((page) =>
      core.includes(page.text)
        ? { page, via: "core" as const, sent: core }
        : { page, via: "recall" as const, sent: kept("recall") }
    ),
    ...(spacePage === undefined
      ? []
      : [{ page: spacePage, via: "space" as const, sent: kept("session") }])
  ]
  const pages: Array<Placed> = []
  const cut: Array<Placed> = []
  for (const { page, via, sent } of rendered)
    (sent.includes(page.text) ? pages : cut).push({ path: page.path, via, whole: page.whole })
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
  const header = ["kind", "questions", "sent", "sent in part", "not sent", "cut by budget"]
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
