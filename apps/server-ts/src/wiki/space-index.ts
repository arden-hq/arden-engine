import { isWithin } from "@arden-hq/std/paths"
import { Effect } from "effect"
import { posix } from "node:path"

import type { SpaceBinding, SpaceStore } from "../persistence/spaces/store.js"
import { memoryIndex, type MemoryIndex } from "./collections.js"
import { canonicalWikiPath } from "./paths.js"
import type { PageRecord } from "./snapshot.js"

/** The folder a Space's page heads: `x.md` and `x/README.md` both head `x/`. */
const spaceFolder = (pagePath: string): string => {
  if (posix.basename(pagePath).toLowerCase() === "readme.md") return posix.dirname(pagePath)
  return pagePath.toLowerCase().endsWith(".md") ? pagePath.slice(0, -3) : pagePath
}

/** Whether `path` is the Space page at `pagePath` or lies under the folder it heads. */
export const spaceOwnsPath = (pagePath: string, path: string): boolean => {
  const boundary = canonicalWikiPath(pagePath)?.toLowerCase()
  const target = canonicalWikiPath(path)?.toLowerCase()
  if (boundary === undefined || target === undefined) return false
  return target === boundary || isWithin(`/${spaceFolder(boundary)}`, `/${target}`)
}

/**
 * Whether an active Space's binding owns `path`. A half-made or unreadable binding owns every
 * path, so nothing is written where that Space's pages might be.
 */
export const bindingOwnsPath = (binding: SpaceBinding, path: string): boolean =>
  binding.page_id === null ||
  binding.page_path === null ||
  canonicalWikiPath(binding.page_path) === undefined ||
  spaceOwnsPath(binding.page_path, path)

/** Whether another active Space holds the page, or its pages and the page's folder overlap. */
export const heldByAnother = (
  others: ReadonlyArray<SpaceBinding>,
  pageId: string,
  pagePath: string
): boolean =>
  others.some(
    (other) =>
      other.page_id === pageId ||
      bindingOwnsPath(other, pagePath) ||
      (other.page_path !== null && spaceOwnsPath(pagePath, other.page_path))
  )

const isBoundPage = (
  bindings: ReadonlyArray<SpaceBinding>,
  pageId: string,
  path: string
): boolean => bindings.some((binding) => binding.page_id === pageId || binding.page_path === path)

type ActiveBindings = Pick<SpaceStore["Service"], "activeBindings">

/** Whether an active Space owns `path`. An archived Space owns nothing. */
export const spaceOwnsWikiPath = (spaces: ActiveBindings, path: string) =>
  spaces
    .activeBindings()
    .pipe(Effect.map((bindings) => bindings.some((binding) => bindingOwnsPath(binding, path))))

/** Whether the page is an active Space's own page. */
export const isSpacePage = (spaces: ActiveBindings, pageId: string, path: string) =>
  spaces.activeBindings().pipe(Effect.map((bindings) => isBoundPage(bindings, pageId, path)))

interface SpacePageRef {
  readonly pageId: string
  readonly pagePath: string
}

const isActive = (record: PageRecord): boolean =>
  record.resource.state === "active" && record.page.lifecycle === "active"

/** The active pages a Space owns: its own page and every page under the folder it heads. */
export const spacePages = (
  pages: ReadonlyArray<PageRecord>,
  space: SpacePageRef
): ReadonlyArray<PageRecord> =>
  pages.filter((record) => isActive(record) && spaceOwnsPath(space.pagePath, record.resource.path))

/** The generated list of the pages a Space owns besides its own page, in at most `maxBytes`. */
export const spacePageIndex = (
  pages: ReadonlyArray<PageRecord>,
  space: SpacePageRef,
  maxBytes: number
): MemoryIndex =>
  memoryIndex(spacePages(pages, space), {
    root: spaceFolder(space.pagePath),
    maxBytes,
    leaveOut: (record) => record.page.pageId === space.pageId
  })

export type SpacePagePlan =
  | { readonly kind: "keep" }
  | { readonly kind: "rebind"; readonly pageId: string; readonly pagePath: string }
  | { readonly kind: "create" }

/**
 * What gives an active Space its page: keep the one it is bound to, bind that page again at
 * the path it now has, or make a fresh one when it is gone or another active Space holds or
 * overlaps it. `others` are the other active Spaces' bindings.
 */
export const planSpacePage = (
  pages: ReadonlyArray<PageRecord>,
  space: SpaceBinding,
  others: ReadonlyArray<SpaceBinding>
): SpacePagePlan => {
  const record =
    space.page_id === null ? undefined : pages.find((page) => page.page.pageId === space.page_id)
  if (record === undefined || !isActive(record)) return { kind: "create" }
  const path = record.resource.path
  if (canonicalWikiPath(path) === undefined) return { kind: "create" }
  if (heldByAnother(others, record.page.pageId, path)) return { kind: "create" }
  return path === space.page_path
    ? { kind: "keep" }
    : { kind: "rebind", pageId: record.page.pageId, pagePath: path }
}
