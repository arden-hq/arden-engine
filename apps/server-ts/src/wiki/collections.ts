import { clipLine } from "@arden-hq/std/text"
import type { Nodes } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
import { posix } from "node:path"

import type { ParsedWikiPage } from "./page.js"
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
