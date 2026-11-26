import {
  MEMORY_OUTCOME,
  MEMORY_SOURCE,
  MEMORY_SPACE_PAGE,
  type RunMemoryContext,
  type RunMemorySource
} from "@arden-hq/protocol/runs"
import { QUESTION_KIND, QUESTION_KINDS, type Question, type QuestionKind } from "./questions.js"

const VIA = { core: "core", recall: "recall", space: "space" } as const
export type Via = (typeof VIA)[keyof typeof VIA]

export interface Placed {
  readonly path: string
  readonly via: Via
  readonly whole: boolean
}

export interface Delivery {
  readonly pages: ReadonlyArray<Placed>
  readonly cut: ReadonlyArray<Placed>
  readonly text: string
  readonly bytes: Readonly<Record<Via | "index", number>>
}

const viaOf = (source: Exclude<RunMemorySource, { readonly kind: "index" }>): Via => {
  switch (source.kind) {
    case MEMORY_SOURCE.core:
      return VIA.core
    case MEMORY_SOURCE.recalled:
      return VIA.recall
    case MEMORY_SOURCE.space:
      return VIA.space
  }
}

const spacePageId = (
  source: Extract<RunMemorySource, { readonly kind: "space" }>
): string | undefined =>
  source.page.kind === MEMORY_SPACE_PAGE.page ? source.page.page_id : undefined

export const deliveryOf = ({
  composition,
  paths,
  text
}: {
  readonly composition: RunMemoryContext
  readonly paths: ReadonlyMap<string, string>
  readonly text: string
}): Delivery => {
  const pages: Array<Placed> = []
  const cut: Array<Placed> = []
  const bytes: Record<Via | "index", number> = { core: 0, recall: 0, space: 0, index: 0 }
  for (const source of composition.sources) {
    if (source.kind === MEMORY_SOURCE.index) {
      bytes.index += source.bytes
      continue
    }
    const via = viaOf(source)
    bytes[via] += source.bytes
    const pageId = source.kind === MEMORY_SOURCE.space ? spacePageId(source) : source.page_id
    if (pageId === undefined) continue
    const path = paths.get(pageId)
    if (path === undefined) throw new Error("A recorded Memory page has no path on the copy")
    const placed = { path, via, whole: source.outcome === MEMORY_OUTCOME.whole }
    if (source.outcome !== MEMORY_OUTCOME.dropped) pages.push(placed)
    else cut.push(placed)
  }
  return { pages, cut, text, bytes }
}

export interface SentResult {
  readonly id: string
  readonly kind: QuestionKind
  readonly space_id: string | null
  readonly sent: boolean
  readonly missing: ReadonlyArray<string>
  readonly cut: ReadonlyArray<string>
  readonly inPart: ReadonlyArray<string>
  readonly misleading: ReadonlyArray<string>
  readonly pages: Delivery["pages"]
  readonly budgetCut: Delivery["cut"]
  readonly bytes: Delivery["bytes"]
}

export const scoreSent = (question: Question, delivery: Delivery): SentResult => {
  const delivered = new Set(delivery.pages.map((page) => page.path))
  const deliveredWhole = new Set(
    delivery.pages.filter((page) => page.whole).map((page) => page.path)
  )
  const cutPaths = new Set(delivery.cut.map((page) => page.path))
  const missing = question.expected_pages.filter((path) => !delivered.has(path))
  const misleading =
    question.kind === QUESTION_KIND.noAnswer
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
  readonly inPart: number
  readonly cut: number
}

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
