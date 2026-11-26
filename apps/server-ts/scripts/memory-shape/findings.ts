import { PATH_SEGMENT, RESOURCE_STATE, type UntrackedFile } from "@arden-hq/revisions/effect"
import { WIKI_PAGE_LIFECYCLE } from "@arden-hq/protocol/wiki"
import { compareCodePoints } from "@arden-hq/std/json"
import { foldSpace } from "@arden-hq/std/text"
import { Effect } from "effect"
import type { Nodes } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
import { posix } from "node:path"

import {
  hasText,
  isMdastNode,
  MDAST_NODE,
  PAGE_KIND,
  pageKind,
  recordFolders,
  type PageKind,
  type RecordFolders
} from "../../src/wiki/collections.js"
import { overPageLimit } from "../../src/wiki/commit.js"
import { pageWikiLinks } from "../../src/wiki/links.js"
import { isReadme, normal, textSentences, visibleText } from "../../src/wiki/page.js"
import {
  activeRunPages,
  followRedirect,
  pageNameIndex,
  resolveWikiLinkTarget,
  type PageRecord,
  type RunPage
} from "../../src/wiki/snapshot.js"
import { untrackedFiles, untrackedPageIds } from "../../src/wiki/untracked.js"

export interface MemoryFolder {
  readonly pages: ReadonlyArray<RunPage>
  readonly untracked: ReadonlyArray<UntrackedFile>
}

export const FINDINGS = {
  duplicate_sentence: "knowledge pages that share one long sentence (one finding per sentence)",
  orphan: "knowledge pages no other page links to",
  two_status: "knowledge pages with more than one dated status line",
  log_section: "knowledge pages with a section headed as a log",
  over_limit: "pages over their size limit",
  duplicate_id: "files that carry the same page id",
  broken_redirect: "redirects that do not end at an active page",
  no_readme: "folders that hold pages but no README",
  empty_page: "pages with no text but headings",
  broken_link: "pages with a link that opens no page",
  shared_title: "active pages that share a title",
  stray_file:
    "files in the Memory folder that history does not hold, as the outside-edit check lists them"
} as const

export type FindingKind = keyof typeof FINDINGS
export const FINDING_KINDS = Object.keys(FINDINGS) as ReadonlyArray<FindingKind>

export interface Finding {
  readonly kind: FindingKind
  readonly paths: ReadonlyArray<string>
}

interface PageShape {
  readonly record: PageRecord
  readonly kind: PageKind["kind"]
  readonly datedStatusLines: number
  readonly logSections: number
  readonly sentenceKeys: ReadonlySet<string>
  readonly empty: boolean
}

const LONG_SENTENCE_CHARS = 60
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?"
const DATE = new RegExp(
  `\\b(?:\\d{4}-\\d{2}-\\d{2}|${MONTH} \\d{1,2}\\b|\\d{1,2} ${MONTH}(?![A-Za-z]))`,
  "u"
)
const STATUS_WORD = /\b(?:status|state)\b/iu
const LOG_HEADING = /\b(?:timeline|history|log|changelog|updates|progress)\b/iu

const folderOf = (path: string): string => {
  const folder = posix.dirname(path)
  return folder === PATH_SEGMENT.current ? "" : folder
}

const readableParts = (body: string) => {
  const lines: Array<string> = []
  const headings: Array<string> = []
  const visit = (node: Nodes): void => {
    if (isMdastNode(node, MDAST_NODE.heading)) headings.push(visibleText(node))
    else if (isMdastNode(node, MDAST_NODE.paragraph)) lines.push(...visibleText(node).split("\n"))
    else if ("children" in node) for (const child of node.children) visit(child)
  }
  const tree = fromMarkdown(body)
  visit(tree)
  return {
    lines,
    headings,
    empty: !tree.children.some((node) => !isMdastNode(node, MDAST_NODE.heading) && hasText(node))
  }
}

const pageShape = (record: PageRecord, folders: RecordFolders): PageShape => {
  const parts = readableParts(record.page.body)
  return {
    record,
    kind: pageKind(folders, record.resource.path).kind,
    datedStatusLines: parts.lines.filter((line) => STATUS_WORD.test(line) && DATE.test(line))
      .length,
    logSections: parts.headings.filter((heading) => LOG_HEADING.test(heading)).length,
    sentenceKeys: new Set(
      parts.lines
        .flatMap((line) => textSentences(foldSpace(line)))
        .filter((sentence) => sentence.length >= LONG_SENTENCE_CHARS)
    ),
    empty: parts.empty
  }
}

const sorted = (paths: Iterable<string>): ReadonlyArray<string> =>
  [...new Set(paths)].sort(compareCodePoints)

const groupsOf = (entries: ReadonlyArray<readonly [key: string, path: string]>) => {
  const groups = new Map<string, Array<string>>()
  for (const [key, path] of entries) groups.set(key, [...(groups.get(key) ?? []), path])
  return [...groups.values()].map(sorted).filter((paths) => paths.length > 1)
}

export const memoryFindings = (folder: MemoryFolder): ReadonlyArray<Finding> => {
  const pages = folder.pages.filter((record) => record.resource.state === RESOURCE_STATE.active)
  const active = activeRunPages(pages)
  const folders = recordFolders(pages)
  const shapes = active.map((record) => pageShape(record, folders))
  const knowledge = shapes.filter((shape) => shape.kind === PAGE_KIND.knowledge)
  const pathOf = (shape: PageShape) => shape.record.resource.path

  const byId = new Map(pages.map((record) => [record.page.pageId, record] as const))
  const names = pageNameIndex(pages)
  const inbound = new Map<string, number>()
  const brokenLinks = new Set<string>()
  for (const source of active) {
    for (const token of pageWikiLinks(source)) {
      const target = resolveWikiLinkTarget(byId, names, source.page.pageId, token)
      if (target === null) brokenLinks.add(source.resource.path)
      else if (target !== source.page.pageId) inbound.set(target, (inbound.get(target) ?? 0) + 1)
    }
  }

  const readmeFolders = new Set(
    active.filter((record) => isReadme(record.resource.path)).map((r) => folderOf(r.resource.path))
  )
  const pageFolders = new Set<string>()
  for (const record of active) {
    for (let path = folderOf(record.resource.path); path !== ""; path = folderOf(path))
      pageFolders.add(path)
  }

  const duplicateIds = groupsOf([
    ...pages.map((record) => [record.page.pageId, record.resource.path] as const),
    ...Effect.runSync(untrackedPageIds(folder.untracked)).map(
      ({ pageId, path }) => [pageId, path] as const
    )
  ])
  const other = untrackedFiles(folder.untracked)

  const each = (paths: Iterable<string>) => sorted(paths).map((path) => [path])
  const found: Record<FindingKind, ReadonlyArray<ReadonlyArray<string>>> = {
    duplicate_sentence: groupsOf(
      knowledge.flatMap((shape) =>
        [...shape.sentenceKeys].map((key) => [key, pathOf(shape)] as const)
      )
    ),
    orphan: each(
      knowledge
        .filter((shape) => folderOf(pathOf(shape)) !== "" || !isReadme(pathOf(shape)))
        .filter((shape) => (inbound.get(shape.record.page.pageId) ?? 0) === 0)
        .map(pathOf)
    ),
    two_status: each(knowledge.filter((shape) => shape.datedStatusLines > 1).map(pathOf)),
    log_section: each(knowledge.filter((shape) => shape.logSections > 0).map(pathOf)),
    over_limit: each(
      active
        .filter(
          (record) =>
            overPageLimit({
              path: record.resource.path,
              pageId: record.page.pageId,
              body: record.page.body
            }) !== undefined
        )
        .map((record) => record.resource.path)
    ),
    duplicate_id: duplicateIds,
    broken_redirect: each(
      pages
        .filter(
          (record) =>
            record.page.lifecycle === WIKI_PAGE_LIFECYCLE.redirect &&
            followRedirect(byId, record.page.pageId) === null
        )
        .map((record) => record.resource.path)
    ),
    no_readme: each([...pageFolders].filter((path) => !readmeFolders.has(path))),
    empty_page: each(shapes.filter((shape) => shape.empty).map(pathOf)),
    broken_link: each(brokenLinks),
    shared_title: groupsOf(
      active.map((record) => [normal(record.page.title), record.resource.path] as const)
    ),
    stray_file: each([
      ...other.notInMemory,
      ...other.otherFiles,
      ...other.unreadableFiles.map((file) => file.path)
    ])
  }
  return FINDING_KINDS.flatMap((kind) =>
    [...found[kind]]
      .sort((left, right) => compareCodePoints(left.join("\n"), right.join("\n")))
      .map((paths) => ({ kind, paths }))
  )
}
