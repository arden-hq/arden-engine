/**
 * Standing facts: the owner's profile and standing preferences, at the root of Memory and sent
 * to every run that reads it. The one place that names their pages.
 */
export const STANDING_FACTS_PAGES = ["me.md", "profile.md"] as const

export const isStandingFactsPage = (page: {
  readonly path: string
  readonly pageId: string
}): boolean => {
  const path = page.path.toLocaleLowerCase()
  const pageId = page.pageId.toLocaleLowerCase()
  return STANDING_FACTS_PAGES.some((name) => path === name || `${pageId}.md` === name)
}

/**
 * The size writers keep each standing-facts page to, and the size each is sent whole up to:
 * the Memory block's allowance for one such page (context/memory-context.ts).
 */
export const STANDING_PAGE_LIMIT_CHARS = 9_000

/**
 * A Core Memory page is condensed before it is full, not after. Writes over the budget are
 * refused, so a page can never be "over": without headroom it sits a few characters under the
 * budget and every later update is refused (seen Nov 12: me.md at 8,998 of 9,000, the capture
 * run gave up). Condensing starts above 90% and aims for 80%, so one condense leaves room for
 * several updates instead of running again on the next batch.
 */
const CONDENSE_ABOVE = 0.9
const CONDENSE_TO = 0.8

export const corePageBudget = (page: {
  readonly path: string
  readonly pageId: string
}): number | undefined => (isStandingFactsPage(page) ? STANDING_PAGE_LIMIT_CHARS : undefined)

/** The size a condensed Core Memory page should end at or under. */
export const coreCondenseTarget = (budget: number): number => Math.floor(budget * CONDENSE_TO)

/** Whether a Core Memory page of this size should be condensed now. */
export const coreNeedsCondensing = (chars: number, budget: number): boolean =>
  chars > Math.floor(budget * CONDENSE_ABOVE)

/** How to condense a Core Memory page. The one wording every notice and refusal uses. */
export const CORE_CONDENSE_ADVICE =
  "Condense wording first, then move project-specific, dated or rarely needed detail " +
  "to the page that owns it, leaving a short link. Keep every general fact and preference."

export const crowdedCorePages = (
  pages: ReadonlyArray<{
    readonly path: string
    readonly pageId: string
    readonly chars: number
  }>
): ReadonlyArray<{
  readonly path: string
  readonly chars: number
  readonly budget: number
  readonly target: number
}> =>
  pages.flatMap((page) => {
    const budget = corePageBudget(page)
    return budget !== undefined && coreNeedsCondensing(page.chars, budget)
      ? [{ path: page.path, chars: page.chars, budget, target: coreCondenseTarget(budget) }]
      : []
  })
