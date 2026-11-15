import { isWithin } from "@arden-hq/std/paths"
import { Effect } from "effect"
import { posix } from "node:path"

import type { SpaceBinding, SpacePageBinding, SpaceStore } from "../persistence/spaces/store.js"
import { memoryIndex, type MemoryIndex } from "./collections.js"
import { isReadme } from "./page.js"
import { canonicalWikiPath } from "./paths.js"
import { activeRunPages, type PageRecord } from "./snapshot.js"

const spaceFolder = (pagePath: string): string => {
  if (isReadme(pagePath)) return posix.dirname(pagePath)
  return pagePath.toLowerCase().endsWith(".md") ? pagePath.slice(0, -3) : pagePath
}

/** Whether `path` is the Space page at `pagePath` or lies under the folder it heads. */
export const spaceOwnsPath = (pagePath: string, path: string): boolean => {
  const boundary = canonicalWikiPath(pagePath)?.toLowerCase()
  const target = canonicalWikiPath(path)?.toLowerCase()
  if (boundary === undefined || target === undefined) return false
  return target === boundary || isWithin(`/${spaceFolder(boundary)}`, `/${target}`)
}

export const bindingOwnsPath = (binding: SpaceBinding, path: string): boolean =>
  binding.page_id === null ||
  binding.page_path === null ||
  canonicalWikiPath(binding.page_path) === undefined ||
  spaceOwnsPath(binding.page_path, path)

/** Whether another active Space's pages and the pages `path` would head overlap. */
export const overlapsAnother = (others: ReadonlyArray<SpaceBinding>, path: string): boolean =>
  others.some(
    (other) =>
      bindingOwnsPath(other, path) ||
      (other.page_path !== null && spaceOwnsPath(path, other.page_path))
  )

/** Whether another active Space holds the page, or overlaps the pages it would head. */
export const heldByAnother = (
  others: ReadonlyArray<SpaceBinding>,
  pageId: string,
  pagePath: string
): boolean => others.some((other) => other.page_id === pageId) || overlapsAnother(others, pagePath)

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

/** The active pages a Space owns: its own page and every page under the folder it heads. */
export const spacePages = (
  pages: ReadonlyArray<PageRecord>,
  space: SpacePageBinding
): ReadonlyArray<PageRecord> =>
  activeRunPages(pages).filter((record) => spaceOwnsPath(space.pagePath, record.resource.path))

/** The generated list of the pages a Space owns besides its own page, in at most `maxBytes`. */
export const spacePageIndex = (
  pages: ReadonlyArray<PageRecord>,
  space: SpacePageBinding,
  maxBytes: number
): MemoryIndex =>
  memoryIndex(spacePages(pages, space), {
    root: spaceFolder(space.pagePath),
    maxBytes,
    leaveOut: (record) => record.page.pageId === space.pageId
  })

export type SpacePagePlan =
  | ({ readonly kind: "keep" } & SpacePageBinding)
  | ({ readonly kind: "rebind" } & SpacePageBinding)
  | { readonly kind: "create" }

export const planSpacePage = (
  pages: ReadonlyArray<PageRecord>,
  space: SpaceBinding,
  others: ReadonlyArray<SpaceBinding>
): SpacePagePlan => {
  const record =
    space.page_id === null
      ? undefined
      : activeRunPages(pages).find((page) => page.page.pageId === space.page_id)
  if (record === undefined) return { kind: "create" }
  const path = record.resource.path
  if (canonicalWikiPath(path) === undefined) return { kind: "create" }
  if (heldByAnother(others, record.page.pageId, path)) return { kind: "create" }
  return {
    kind: path === space.page_path ? "keep" : "rebind",
    pageId: record.page.pageId,
    pagePath: path
  }
}
