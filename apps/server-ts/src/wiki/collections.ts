import { WIKI_REPORT_FIELDS } from "@arden-hq/protocol/wiki"
import { parseCalendarDay } from "@arden-hq/std/time"
import { clipLine } from "@arden-hq/std/text"
import type { Nodes } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
import { posix } from "node:path"

import { isReadme, normal, wikiPageSummary, type ParsedWikiPage } from "./page.js"
import { activeRunPages, type PageRecord } from "./snapshot.js"

export const DIRECTORY_CONTRACT_HEADINGS = [
  "Purpose",
  "Producers",
  "Consumers",
  "Boundaries",
  "Retention"
] as const

export const hasText = (node: Nodes): boolean => {
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

export const IMPORTED_DIRECTORY = "imported"

export const isImportedPath = (path: string): boolean =>
  path.toLowerCase().startsWith(`${IMPORTED_DIRECTORY}/`)

/** Who writes a record folder: one Automation publishing reports, or the import of notes. */
type RecordProducer =
  | { readonly kind: "automation"; readonly automationId: string }
  | { readonly kind: "import" }

interface RecordFolder {
  readonly directory: string
  readonly producer: RecordProducer
}

/**
 * What a page is. Knowledge is kept current by chats and upkeep. A record is kept as its
 * producer wrote it: every page in a record folder, at any depth, but the folder's README,
 * which is its contract. A record's `day` is the date its file name starts with, if any.
 */
export type PageKind =
  | { readonly kind: "knowledge" }
  | { readonly kind: "contract"; readonly folder: RecordFolder }
  | { readonly kind: "record"; readonly folder: RecordFolder; readonly day: string | undefined }

/** The record folders of Memory, by directory as `normal` spells it. */
export type RecordFolders = ReadonlyMap<string, RecordFolder>

/** The Automation a page names as its producer: on a contract, the folder's; on a record, its. */
export const markedProducer = (page: ParsedWikiPage): string | undefined => {
  const producer = page.metadata[WIKI_REPORT_FIELDS.automationId]
  return typeof producer === "string" && producer.length > 0 ? producer : undefined
}

const folderProducer = (readmePath: string, page: ParsedWikiPage): RecordProducer | undefined => {
  if (isImportedPath(readmePath)) return { kind: "import" }
  const automationId = markedProducer(page)
  return automationId === undefined ? undefined : { kind: "automation", automationId }
}

/**
 * The record folders of Memory: every folder whose active README names its producing Automation,
 * and `imported/`, which holds imported notes by its name, README or not.
 */
export const recordFolders = (pages: ReadonlyArray<PageRecord>): RecordFolders => {
  const folders = new Map<string, RecordFolder>([
    [normal(IMPORTED_DIRECTORY), { directory: IMPORTED_DIRECTORY, producer: { kind: "import" } }]
  ])
  for (const record of pages) {
    const path = record.resource.path
    if (
      record.resource.state !== "active" ||
      record.page.lifecycle !== "active" ||
      !isReadme(path) ||
      posix.dirname(path) === "."
    )
      continue
    const directory = posix.dirname(path)
    const producer = folderProducer(path, record.page)
    if (producer !== undefined) folders.set(normal(directory), { directory, producer })
  }
  return folders
}

const DAY_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:$|[^\d])/u

const dayOfName = (path: string): string | undefined => {
  const day = DAY_PREFIX.exec(posix.basename(path, posix.extname(path)))?.[1]
  return day !== undefined && parseCalendarDay(day) !== undefined ? day : undefined
}

export const pageKind = (folders: RecordFolders, path: string): PageKind => {
  const directory = posix.dirname(path)
  const own = folders.get(normal(directory))
  if (own !== undefined && isReadme(path)) return { kind: "contract", folder: own }
  for (let at = directory; at !== "." && at !== "/"; at = posix.dirname(at)) {
    const folder = folders.get(normal(at))
    if (folder === undefined) continue
    return {
      kind: "record",
      folder,
      day: folder.producer.kind === "automation" ? dayOfName(path) : undefined
    }
  }
  return { kind: "knowledge" }
}

/** The Automation whose folder holds this page, as a record or as the contract; undefined otherwise. */
export const producingAutomation = (folders: RecordFolders, path: string): string | undefined => {
  const kind = pageKind(folders, path)
  return kind.kind !== "knowledge" && kind.folder.producer.kind === "automation"
    ? kind.folder.producer.automationId
    : undefined
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
  const folders = recordFolders(active)
  const directPages = new Map<string, number>()
  for (const page of active) {
    const key = posix.dirname(page.resource.path).toLowerCase()
    directPages.set(key, (directPages.get(key) ?? 0) + 1)
  }
  return active
    .filter(
      (record) => isReadme(record.resource.path) && posix.dirname(record.resource.path) !== "."
    )
    .map((record): WikiCollection => {
      const directory = posix.dirname(record.resource.path)
      const sections = sectionsOf(record.page)
      const kind = pageKind(folders, record.resource.path)
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
        producer:
          kind.kind === "contract" && kind.folder.producer.kind === "automation"
            ? kind.folder.producer.automationId
            : undefined,
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

interface MemoryIndexFold {
  readonly folder: string
  readonly pages: number
}

/**
 * The generated list of the pages under one folder: every active page has a line, falls under
 * a folded folder's line, or is `unlisted`, past the size once every folder is folded.
 * `folded` is in the order folders were folded; `text` holds the lines in path order and names
 * no count, so a page that joins or leaves a folded folder leaves the text as it was.
 */
export interface MemoryIndex {
  readonly root: string
  readonly lines: ReadonlyArray<MemoryIndexLine>
  readonly folded: ReadonlyArray<MemoryIndexFold>
  readonly unlisted: number
  readonly text: string
  readonly bytes: number
}

const INDEX_SUMMARY_CHARS = 120

const encoder = new TextEncoder()
const byteLength = (value: string): number => encoder.encode(value).byteLength

const indexLine = ({ path, summary }: MemoryIndexLine): string =>
  summary === null ? `- ${path}` : `- ${path}: ${summary}`

const foldLine = (folder: string): string => `- ${folder === "" ? "(top level)" : folder}/ (folded)`

/** Reads each page's summary line ahead of the first index, so a turn does not wait for it. */
export const prepareMemoryIndex = (pages: ReadonlyArray<PageRecord>): void => {
  for (const record of pages) wikiPageSummary(record.page, INDEX_SUMMARY_CHARS)
}

/**
 * The index of the active pages under `root` ("" for all of Memory), in at most `maxBytes`.
 * Over the size it folds the folder with the most direct pages, one at a time, and the root
 * folder last, until it fits. When every folder that can fold is folded and it still does not
 * fit, lines are left out from the end. Pure: the same pages give the same index.
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
  const prefix = options.root === "" ? "" : `${options.root}/`.toLowerCase()
  const listed = activeRunPages(pages)
    .filter(
      (record) =>
        record.resource.path.toLowerCase().startsWith(prefix) && options.leaveOut?.(record) !== true
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
        saves: lineBytes(lines) - byteLength(foldLine(folder)) - 1
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
    ...lines.map((line) => ({ key: line.path, text: indexLine(line), line, fold: undefined })),
    ...folded.map((fold) => ({
      key: `${fold.folder}/`,
      text: foldLine(fold.folder),
      line: undefined,
      fold
    }))
  ].sort((left, right) => left.key.localeCompare(right.key))
  let shown = entries.length
  let shownBytes = entries.reduce((sum, entry) => sum + byteLength(entry.text) + 1, 0) - 1
  while (shown > 0 && shownBytes > options.maxBytes) {
    shown -= 1
    shownBytes -= byteLength(entries[shown]?.text ?? "") + 1
  }
  const kept = entries.slice(0, shown)
  const text = kept.map((entry) => entry.text).join("\n")
  return {
    root: options.root,
    lines: kept.flatMap((entry) => (entry.line === undefined ? [] : [entry.line])),
    folded: folded.filter((fold) => kept.some((entry) => entry.fold === fold)),
    unlisted: entries
      .slice(shown)
      .reduce((sum, entry) => sum + (entry.fold === undefined ? 1 : entry.fold.pages), 0),
    text,
    bytes: byteLength(text)
  }
}
