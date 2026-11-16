import { posix } from "node:path"

import { isRulesPage } from "../wiki/code-owned-pages.js"
import { isReadme } from "../wiki/page.js"

/**
 * Standing facts: the owner's profile and standing preferences, at the root of Memory and sent
 * to every run that reads it. The one place that names their pages.
 */
export const STANDING_FACTS_PAGES = ["me.md", "profile.md"] as const

/** What the Memory tools say about the standing-facts pages' limit. */
export const STANDING_LIMIT_NOTE = `${STANDING_FACTS_PAGES.join(" and ")} are root profile pages with a size limit; a write that grows one past it is refused.`

export const isStandingFactsPage = (page: {
  readonly path: string
  readonly pageId: string
}): boolean => {
  const path = page.path.toLocaleLowerCase()
  const pageId = page.pageId.toLocaleLowerCase()
  return STANDING_FACTS_PAGES.some((name) => path === name || `${pageId}.md` === name)
}

/** Why a new page may not be made at `path`: only standing facts live at the Memory root. */
export const createRefusal = (
  path: string
): { readonly code: "invalid" | "blocked"; readonly message: string } | undefined => {
  if (!path.endsWith(".md"))
    return { code: "invalid", message: "Memory page paths must end in .md" }
  if ((posix.dirname(path) === "." && !isStandingFactsPage({ path, pageId: "" })) || isReadme(path))
    return {
      code: "blocked",
      message: "Memory pages can be created only inside an existing Memory folder"
    }
  return undefined
}

const STANDING_PAGE_LIMIT_CHARS = 9_000

/**
 * A Core Memory page is condensed before it is full, not after. Writes over the budget are
 * refused, so a page can never be "over": without headroom it sits a few characters under the
 * budget and every later update is refused (seen Nov 12: me.md at 8,998 of 9,000, the capture
 * run gave up). Condensing starts above 90% and aims for 80%, so one condense leaves room for
 * several updates instead of running again on the next batch.
 */
const CONDENSE_ABOVE = 0.9
const CONDENSE_TO = 0.8

const RULES_PAGE_LIMIT_CHARS = 128 * 1024

/** The limit of a page sent whole to every run or chat. */
export const corePageBudget = (page: {
  readonly path: string
  readonly pageId: string
}): number | undefined => {
  if (isStandingFactsPage(page)) return STANDING_PAGE_LIMIT_CHARS
  return isRulesPage(page.path) ? RULES_PAGE_LIMIT_CHARS : undefined
}

/** The size a condensed Core Memory page should end at or under. */
export const coreCondenseTarget = (budget: number): number => Math.floor(budget * CONDENSE_TO)

/** Whether a Core Memory page of this size should be condensed now. */
export const coreNeedsCondensing = (chars: number, budget: number): boolean =>
  chars > Math.floor(budget * CONDENSE_ABOVE)

/** How to condense a Core Memory page. The one wording every notice and refusal uses. */
export const CORE_CONDENSE_ADVICE =
  "Condense wording first, then move project-specific, dated or rarely needed detail " +
  "to the page that owns it, leaving a short link. Keep every general fact and preference."

/** How far a page body is over its limit, or undefined when it fits or has none. */
export const overPageLimit = (page: {
  readonly path: string
  readonly pageId: string
  readonly body: string
}): { readonly chars: number; readonly limit: number } | undefined => {
  const limit = corePageBudget(page)
  return limit === undefined || page.body.length <= limit
    ? undefined
    : { chars: page.body.length, limit }
}

/** Why a write that grows a page past its limit is refused: the owner hears the limit, a run
 *  how to condense. */
export const pageLimitRefusal = (
  byOwner: boolean,
  path: string,
  over: { readonly chars: number; readonly limit: number }
): string => {
  const target = coreCondenseTarget(over.limit)
  return byOwner
    ? `${path} would have ${over.chars} characters; its limit is ${over.limit}, because it is sent whole to every chat. ` +
        `Nothing was saved. Shorten it by at least ${over.chars - over.limit} characters.`
    : `${path} would have ${over.chars} characters, but it is sent whole to every run and is limited to ${over.limit}. ` +
        `Nothing was saved. Cut at least ${over.chars - over.limit} characters; aim for ${target} or fewer ` +
        `(${over.chars - target} less) so later updates fit. Trimming a few words will not do it. ` +
        `${CORE_CONDENSE_ADVICE} Then retry with the new fact included.`
}

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
