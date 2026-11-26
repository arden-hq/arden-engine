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

export const spaceOwnsPath = (pagePath: string, path: string): boolean => {
  const boundary = canonicalWikiPath(pagePath)?.toLowerCase()
  const target = canonicalWikiPath(path)?.toLowerCase()
  if (boundary === undefined || target === undefined) return false
  return target === boundary || isWithin(`/${spaceFolder(boundary)}`, `/${target}`)
}

const SPACE_BINDING = { bound: "bound", halfMade: "half_made" } as const

export type SpaceBinding =
  | {
      readonly kind: typeof SPACE_BINDING.bound
      readonly space_id: string
      readonly page_id: string
      readonly page_path: string
    }
  | {
      readonly kind: typeof SPACE_BINDING.halfMade
      readonly space_id: string
      readonly row: SpaceBindingRow
    }

export const spaceBinding = (row: SpaceBindingRow): SpaceBinding =>
  row.page_id !== null && row.page_path !== null && canonicalWikiPath(row.page_path) !== undefined
    ? {
        kind: SPACE_BINDING.bound,
        space_id: row.space_id,
        page_id: row.page_id,
        page_path: row.page_path
      }
    : { kind: SPACE_BINDING.halfMade, space_id: row.space_id, row }

export const bindingOwnsPath = (binding: SpaceBinding, path: string): boolean =>
  binding.kind === SPACE_BINDING.halfMade || spaceOwnsPath(binding.page_path, path)

const overlapsAnother = (others: ReadonlyArray<SpaceBinding>, path: string): boolean =>
  others.some(
    (other) =>
      bindingOwnsPath(other, path) ||
      (other.kind === SPACE_BINDING.bound && spaceOwnsPath(path, other.page_path))
  )

export const heldByAnother = (
  others: ReadonlyArray<SpaceBinding>,
  pageId: string,
  pagePath: string
): boolean =>
  others.some((other) => other.kind === SPACE_BINDING.bound && other.page_id === pageId) ||
  overlapsAnother(others, pagePath)

export const freeSpacePage = (
  others: ReadonlyArray<SpaceBinding>,
  page: SpacePageBinding
): FreeSpacePage | undefined =>
  heldByAnother(others, page.pageId, page.pagePath) ? undefined : (page as FreeSpacePage)

const keepsPage = (binding: SpaceBinding, pageId: string, path: string): boolean => {
  switch (binding.kind) {
    case SPACE_BINDING.bound:
      return binding.page_id === pageId || binding.page_path === path
    case SPACE_BINDING.halfMade:
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

export const isSpacePage = (
  spaces: ActiveBindings,
  pageId: string,
  path: string
): Effect.Effect<boolean, SpaceStoreError, never> =>
  activeSpaceBindings(spaces).pipe(Effect.map((bindings) => isBoundPage(bindings, pageId, path)))

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

const spacePages = (
  pages: ReadonlyArray<RunPage>,
  space: SpacePageBinding
): ReadonlyArray<RunPage> =>
  activeRunPages(pages).filter((record) => spaceOwnsPath(space.pagePath, record.resource.path))

export const spacePageList = (
  pages: ReadonlyArray<RunPage>,
  space: SpacePageBinding
): { readonly root: string; readonly pages: ReadonlyArray<RunPage> } => ({
  root: spaceFolder(space.pagePath),
  pages: spacePages(pages, space).filter((record) => record.page.pageId !== space.pageId)
})

export const SPACE_PAGE_PLAN = { keep: "keep", rebind: "rebind", create: "create" } as const

export type SpacePagePlan =
  | {
      readonly kind: typeof SPACE_PAGE_PLAN.keep | typeof SPACE_PAGE_PLAN.rebind
      readonly page: FreeSpacePage
    }
  | { readonly kind: typeof SPACE_PAGE_PLAN.create }

export const planSpacePage = (
  pages: ReadonlyArray<RunPage>,
  space: SpaceBindingRow,
  others: ReadonlyArray<SpaceBinding>
): SpacePagePlan => {
  const record =
    space.page_id === null
      ? undefined
      : activeRunPages(pages).find((page) => page.page.pageId === space.page_id)
  if (record === undefined) return { kind: SPACE_PAGE_PLAN.create }
  const path = record.resource.path
  if (canonicalWikiPath(path) === undefined) return { kind: SPACE_PAGE_PLAN.create }
  const page = freeSpacePage(others, { pageId: record.page.pageId, pagePath: path })
  if (page === undefined) return { kind: SPACE_PAGE_PLAN.create }
  return { kind: path === space.page_path ? SPACE_PAGE_PLAN.keep : SPACE_PAGE_PLAN.rebind, page }
}
