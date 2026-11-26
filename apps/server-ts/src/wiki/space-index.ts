import { isWithin } from "@arden-hq/std/paths"
import { Effect } from "effect"
import { posix } from "node:path"

import type {
  FreeSpacePage,
  SpaceBindingRow,
  SpacePageBinding,
  SpaceStore
} from "../persistence/spaces/store.js"
import { isReadme } from "./page.js"
import { canonicalWikiPath } from "./paths.js"
import { activeRunPages, type RunPage } from "./snapshot.js"
import type { SpaceStoreError } from "../persistence/spaces/store.js"

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

export type SpaceBinding =
  | {
      readonly kind: "bound"
      readonly space_id: string
      readonly page_id: string
      readonly page_path: string
    }
  | { readonly kind: "half_made"; readonly space_id: string; readonly row: SpaceBindingRow }

export const spaceBinding = (row: SpaceBindingRow): SpaceBinding =>
  row.page_id !== null && row.page_path !== null && canonicalWikiPath(row.page_path) !== undefined
    ? { kind: "bound", space_id: row.space_id, page_id: row.page_id, page_path: row.page_path }
    : { kind: "half_made", space_id: row.space_id, row }

export const bindingOwnsPath = (binding: SpaceBinding, path: string): boolean =>
  binding.kind === "half_made" || spaceOwnsPath(binding.page_path, path)

/** Whether another active Space's pages and the pages `path` would head overlap. */
const overlapsAnother = (others: ReadonlyArray<SpaceBinding>, path: string): boolean =>
  others.some(
    (other) =>
      bindingOwnsPath(other, path) ||
      (other.kind === "bound" && spaceOwnsPath(path, other.page_path))
  )

/** Whether another active Space holds the page, or overlaps the pages it would head. */
export const heldByAnother = (
  others: ReadonlyArray<SpaceBinding>,
  pageId: string,
  pagePath: string
): boolean =>
  others.some((other) => other.kind === "bound" && other.page_id === pageId) ||
  overlapsAnother(others, pagePath)

export const freeSpacePage = (
  others: ReadonlyArray<SpaceBinding>,
  page: SpacePageBinding
): FreeSpacePage | undefined =>
  heldByAnother(others, page.pageId, page.pagePath) ? undefined : (page as FreeSpacePage)

const keepsPage = (binding: SpaceBinding, pageId: string, path: string): boolean => {
  switch (binding.kind) {
    case "bound":
      return binding.page_id === pageId || binding.page_path === path
    case "half_made":
      return binding.row.page_id === pageId || binding.row.page_path === path
  }
}

const isBoundPage = (
  bindings: ReadonlyArray<SpaceBinding>,
  pageId: string,
  path: string
): boolean => bindings.some((binding) => keepsPage(binding, pageId, path))

type ActiveBindings = Pick<SpaceStore["Service"], "activeBindings">

export const activeSpaceBindings = (
  spaces: ActiveBindings
): Effect.Effect<SpaceBinding[], SpaceStoreError, never> =>
  spaces.activeBindings().pipe(Effect.map((rows) => rows.map(spaceBinding)))

export const spaceOwnsWikiPath = (
  spaces: ActiveBindings,
  path: string
): Effect.Effect<boolean, SpaceStoreError, never> =>
  activeSpaceBindings(spaces).pipe(
    Effect.map((bindings) => bindings.some((binding) => bindingOwnsPath(binding, path)))
  )

/** Whether the page is an active Space's own page. */
export const isSpacePage = (
  spaces: ActiveBindings,
  pageId: string,
  path: string
): Effect.Effect<boolean, SpaceStoreError, never> =>
  activeSpaceBindings(spaces).pipe(Effect.map((bindings) => isBoundPage(bindings, pageId, path)))

/** `isSpacePage` for many pages, with the bindings read at most once, when first asked for. */
export const spacePageCheck = (
  spaces: ActiveBindings
): Effect.Effect<
  (pageId: string, path: string) => Effect.Effect<boolean, SpaceStoreError, never>,
  never,
  never
> =>
  Effect.cached(Effect.suspend(() => activeSpaceBindings(spaces))).pipe(
    Effect.map(
      (bindings) => (pageId: string, path: string) =>
        bindings.pipe(Effect.map((all) => isBoundPage(all, pageId, path)))
    )
  )

/** The active pages a Space owns: its own page and every page under the folder it heads. */
const spacePages = (
  pages: ReadonlyArray<RunPage>,
  space: SpacePageBinding
): ReadonlyArray<RunPage> =>
  activeRunPages(pages).filter((record) => spaceOwnsPath(space.pagePath, record.resource.path))

/** What a Space's list of its other pages holds: the pages under the folder it heads, but its own. */
export const spacePageList = (
  pages: ReadonlyArray<RunPage>,
  space: SpacePageBinding
): { readonly root: string; readonly pages: ReadonlyArray<RunPage> } => ({
  root: spaceFolder(space.pagePath),
  pages: spacePages(pages, space).filter((record) => record.page.pageId !== space.pageId)
})

export type SpacePagePlan =
  | { readonly kind: "keep" | "rebind"; readonly page: FreeSpacePage }
  | { readonly kind: "create" }

export const planSpacePage = (
  pages: ReadonlyArray<RunPage>,
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
