const PROFILE_PAGE_BUDGET_CHARS = 9_000
const ROOT_INDEX_BUDGET_CHARS = 2_500

export const corePageBudget = (page: {
  readonly path: string
  readonly pageId: string
}): number | undefined => {
  const path = page.path.toLocaleLowerCase()
  const pageId = page.pageId.toLocaleLowerCase()
  if (path === "readme.md") return ROOT_INDEX_BUDGET_CHARS
  if (path === "me.md" || path === "profile.md" || pageId === "me" || pageId === "profile")
    return PROFILE_PAGE_BUDGET_CHARS
  return undefined
}

export const oversizedCorePages = (
  pages: ReadonlyArray<{
    readonly path: string
    readonly pageId: string
    readonly chars: number
  }>
): ReadonlyArray<{ readonly path: string; readonly chars: number; readonly budget: number }> =>
  pages.flatMap((page) => {
    const budget = corePageBudget(page)
    return budget !== undefined && page.chars > budget
      ? [{ path: page.path, chars: page.chars, budget }]
      : []
  })
