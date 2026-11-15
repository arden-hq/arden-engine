import { isWithin } from "@arden-hq/std/paths"
import { Effect } from "effect"
import { posix } from "node:path"

import type {
  FreeSpacePage,
  SpaceBindingRow,
  SpacePageBinding,
  SpaceStore
} from "../persistence/spaces/store.js"
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

/**
 * Which pages an active Space is bound to. A half-made binding, with a page column missing or a
 * path that does not read, owns every path, so nothing is written where its pages might be.
 */
export type SpaceBinding =
  | {
      readonly kind: "bound"
      readonly space_id: string
      readonly page_id: string
      readonly page_path: string
    }
  | ({ readonly kind: "half_made" } & SpaceBindingRow)

export const spaceBinding = (row: SpaceBindingRow): SpaceBinding =>
  row.page_id !== null && row.page_path !== null && canonicalWikiPath(row.page_path) !== undefined
    ? { kind: "bound", space_id: row.space_id, page_id: row.page_id, page_path: row.page_path }
    : { kind: "half_made", space_id: row.space_id, page_id: row.page_id, page_path: row.page_path }

export const bindingOwnsPath = (binding: SpaceBinding, path: string): boolean =>
  binding.kind === "half_made" || spaceOwnsPath(binding.page_path, path)

/** Whether another active Space's pages and the pages `path` would head overlap. */
const overlapsAnother = (others: ReadonlyArray<SpaceBinding>, path: string): boolean =>
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

export const freeSpacePage = (
  others: ReadonlyArray<SpaceBinding>,
  page: SpacePageBinding
): FreeSpacePage | undefined =>
  heldByAnother(others, page.pageId, page.pagePath) ? undefined : (page as FreeSpacePage)

const isBoundPage = (
  bindings: ReadonlyArray<SpaceBinding>,
  pageId: string,
  path: string
): boolean => bindings.some((binding) => binding.page_id === pageId || binding.page_path === path)

type ActiveBindings = Pick<SpaceStore["Service"], "activeBindings">

/** The active Spaces' bindings. An archived Space owns nothing. */
export const activeSpaceBindings = (spaces: ActiveBindings) =>
  spaces.activeBindings().pipe(Effect.map((rows) => rows.map(spaceBinding)))

/** Whether an active Space owns `path`. */
export const spaceOwnsWikiPath = (spaces: ActiveBindings, path: string) =>
  activeSpaceBindings(spaces).pipe(
    Effect.map((bindings) => bindings.some((binding) => bindingOwnsPath(binding, path)))
  )

/** Whether the page is an active Space's own page. */
export const isSpacePage = (spaces: ActiveBindings, pageId: string, path: string) =>
  activeSpaceBindings(spaces).pipe(Effect.map((bindings) => isBoundPage(bindings, pageId, path)))

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
  | { readonly kind: "keep" | "rebind"; readonly page: FreeSpacePage }
  | { readonly kind: "create" }

export const planSpacePage = (
  pages: ReadonlyArray<PageRecord>,
  space: SpaceBindingRow,
  others: ReadonlyArray<SpaceBinding>
): SpacePagePlan => {
  const record =
    space.page_id === null
      ? undefined
      : activeRunPages(pages).find((page) => page.page.pageId === space.page_id)
  if (record === undefined) return { kind: "create" }
  const path = record.resource.path
  if (canonicalWikiPath(path) === undefined) return { kind: "create" }
  const page = freeSpacePage(others, { pageId: record.page.pageId, pagePath: path })
  if (page === undefined) return { kind: "create" }
  return { kind: path === space.page_path ? "keep" : "rebind", page }
}
