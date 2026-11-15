import { clipLine } from "@arden-hq/std/text"
import type { Nodes } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
import { posix } from "node:path"

import { wikiPageSummary, type ParsedWikiPage } from "./page.js"
import type { PageRecord } from "./snapshot.js"

export const DIRECTORY_CONTRACT_HEADINGS = [
  "Purpose",
  "Producers",
  "Consumers",
  "Boundaries",
  "Retention"
] as const

const hasText = (node: Nodes): boolean => {
  if (node.type === "html" || node.type === "definition") return false
  if ("value" in node) return node.value.trim().length > 0
  return "children" in node && node.children.some(hasText)
}

export const directorySections = (body: string): ReadonlyMap<string, string> => {
  const nodes = fromMarkdown(body).children
  const sections = new Map<string, string>()
  for (const [index, node] of nodes.entries()) {
    if (node.type !== "heading" || node.depth !== 2) continue
    const name = node.children.map((child) => ("value" in child ? child.value : "")).join("")
    const start = node.position?.end.offset
    const following = nodes.slice(index + 1)
    const boundary = following.findIndex((next) => next.type === "heading" && next.depth <= 2)
    const content = boundary < 0 ? following : following.slice(0, boundary)
    const end = boundary < 0 ? undefined : following[boundary]?.position?.start.offset
    if (start !== undefined)
      sections.set(name, content.some(hasText) ? body.slice(start, end).trim() : "")
  }
  return sections
}

const pageSections = new WeakMap<ParsedWikiPage, ReadonlyMap<string, string>>()
const sectionsOf = (page: ParsedWikiPage): ReadonlyMap<string, string> => {
  const cached = pageSections.get(page)
  if (cached !== undefined) return cached
  const sections = directorySections(page.body)
  pageSections.set(page, sections)
  return sections
}

export interface WikiCollection {
  readonly directory: string
  readonly path: string
  readonly pageId: string
  readonly version: string
  readonly title: string
  readonly purpose: string
  readonly producers: string
  readonly consumers: string
  readonly records: string
  readonly producer: string | undefined
  readonly contract: "complete" | "incomplete"
  readonly pageCount: number
}

const excerpt = (text: string | undefined): string => clipLine(text ?? "", 240)

export const wikiCollections = (
  pages: ReadonlyArray<PageRecord>
): ReadonlyArray<WikiCollection> => {
  const active = pages.filter(
    (record) => record.resource.state === "active" && record.page.lifecycle === "active"
  )
  const directPages = new Map<string, number>()
  for (const page of active) {
    const key = posix.dirname(page.resource.path).toLowerCase()
    directPages.set(key, (directPages.get(key) ?? 0) + 1)
  }
  return active
    .filter(
      (record) =>
        posix.basename(record.resource.path).toLowerCase() === "readme.md" &&
        posix.dirname(record.resource.path) !== "."
    )
    .map((record): WikiCollection => {
      const directory = posix.dirname(record.resource.path)
      const sections = sectionsOf(record.page)
      const producer = record.page.metadata["producer_automation_id"]
      return {
        directory,
        path: record.resource.path,
        pageId: record.page.pageId,
        version: record.resource.versionId,
        title: record.page.title,
        purpose: excerpt(sections.get("Purpose")),
        producers: excerpt(sections.get("Producers")),
        consumers: excerpt(sections.get("Consumers")),
        records: excerpt(sections.get("Records")),
        producer: typeof producer === "string" ? producer : undefined,
        contract: DIRECTORY_CONTRACT_HEADINGS.every((heading) => sections.get(heading))
          ? "complete"
          : "incomplete",
        pageCount: (directPages.get(directory.toLowerCase()) ?? 1) - 1
      }
    })
    .sort((left, right) => left.directory.localeCompare(right.directory))
}

export const renderCollection = (collection: WikiCollection): string =>
  [
    `- ${collection.path}: ${collection.purpose || excerpt(collection.title)}`,
    `(${collection.pageCount} direct pages; ${collection.contract} contract)`,
    ...(collection.producers ? [`Producers (declared): ${collection.producers}`] : []),
    ...(collection.consumers ? [`Read for: ${collection.consumers}`] : []),
    ...(collection.records ? [`Records: ${collection.records}`] : [])
  ].join(" ")

interface MemoryIndexLine {
  readonly path: string
  readonly summary: string | null
}

/** A folder whose direct pages are counted on one line instead of listed; "" is the root. */
interface MemoryIndexFold {
  readonly folder: string
  readonly pages: number
}

/**
 * The generated list of the pages under one folder: every active page has a line, or is
 * counted in a folded folder; none is left out. `folded` is in the order folders were folded;
 * `text` holds the lines in path order.
 */
export interface MemoryIndex {
  readonly root: string
  readonly lines: ReadonlyArray<MemoryIndexLine>
  readonly folded: ReadonlyArray<MemoryIndexFold>
  readonly text: string
  readonly bytes: number
}

// At 120 characters a summary line still says what the page is for, and on the owner's copy
// every page outside the four largest folders fits the Memory block's index allowance.
const INDEX_SUMMARY_CHARS = 120

const encoder = new TextEncoder()
const byteLength = (value: string): number => encoder.encode(value).byteLength

const indexLine = ({ path, summary }: MemoryIndexLine): string =>
  summary === null ? `- ${path}` : `- ${path}: ${summary}`

const foldLine = ({ folder, pages }: MemoryIndexFold): string =>
  `- ${folder === "" ? "(top level)" : folder}/ (${countLabel(pages)}, folded)`

const countLabel = (pages: number): string => (pages === 1 ? "1 page" : `${pages} pages`)

/** Reads each page's summary line ahead of the first index, so a turn does not wait for it. */
export const prepareMemoryIndex = (pages: ReadonlyArray<PageRecord>): void => {
  for (const record of pages) wikiPageSummary(record.page, INDEX_SUMMARY_CHARS)
}

/**
 * The index of the active pages under `root` ("" for all of Memory), in at most `maxBytes`
 * when that is possible. Over the size it folds the folder with the most direct pages, one at
 * a time, and the root folder last; it stops folding once it fits, or when every folder is
 * folded. Pure: the same pages give the same index.
 */
export const memoryIndex = (
  pages: ReadonlyArray<PageRecord>,
  options: {
    readonly root: string
    readonly maxBytes: number
    /** Pages the caller sends another way; they are neither listed nor counted. */
    readonly leaveOut?: (record: PageRecord) => boolean
  }
): MemoryIndex => {
  const prefix = options.root === "" ? "" : `${options.root}/`
  const listed = pages
    .filter(
      (record) =>
        record.resource.state === "active" &&
        record.page.lifecycle === "active" &&
        record.resource.path.startsWith(prefix) &&
        options.leaveOut?.(record) !== true
    )
    .map((record) => ({
      path: record.resource.path,
      summary: wikiPageSummary(record.page, INDEX_SUMMARY_CHARS)
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
  const byFolder = new Map<string, Array<MemoryIndexLine>>()
  for (const line of listed) {
    const folder = posix.dirname(line.path)
    const key = folder === "." ? "" : folder
    byFolder.set(key, [...(byFolder.get(key) ?? []), line])
  }
  const lineBytes = (lines: ReadonlyArray<MemoryIndexLine>): number =>
    lines.reduce((sum, line) => sum + byteLength(indexLine(line)) + 1, 0)
  const folded: Array<MemoryIndexFold> = []
  let bytes = lineBytes(listed)
  while (bytes > options.maxBytes) {
    const next = [...byFolder]
      .filter(([folder]) => !folded.some((fold) => fold.folder === folder))
      .map(([folder, lines]) => ({
        folder,
        lines,
        saves: lineBytes(lines) - byteLength(foldLine({ folder, pages: lines.length })) - 1
      }))
      .filter((candidate) => candidate.saves > 0)
      .sort(
        (left, right) =>
          Number(left.folder === options.root) - Number(right.folder === options.root) ||
          right.lines.length - left.lines.length ||
          left.folder.localeCompare(right.folder)
      )[0]
    if (next === undefined) break
    folded.push({ folder: next.folder, pages: next.lines.length })
    bytes -= next.saves
  }
  const foldedFolders = new Set(folded.map((fold) => fold.folder))
  const lines = listed.filter((line) => {
    const folder = posix.dirname(line.path)
    return !foldedFolders.has(folder === "." ? "" : folder)
  })
  const entries = [
    ...lines.map((line) => ({ key: line.path, text: indexLine(line) })),
    ...folded.map((fold) => ({ key: `${fold.folder}/`, text: foldLine(fold) }))
  ].sort((left, right) => left.key.localeCompare(right.key))
  const text = entries.map((entry) => entry.text).join("\n")
  return { root: options.root, lines, folded, text, bytes: byteLength(text) }
}
