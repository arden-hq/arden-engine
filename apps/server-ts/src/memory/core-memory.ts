import { PATH_SEGMENT } from "@arden-hq/revisions/effect"
import { posix } from "node:path"

import { isRulesPage } from "../wiki/code-owned-pages.js"
import { isReadme } from "../wiki/page.js"

export const STANDING_FACTS_PAGES = ["me.md", "profile.md"] as const

export const STANDING_LIMIT_NOTE = `${STANDING_FACTS_PAGES.join(" and ")} are root profile pages with a size limit; a write that grows one past it is refused.`

export const isStandingFactsPage = (page: {
  readonly path: string
  readonly pageId: string
}): boolean => {
  const path = page.path.toLocaleLowerCase()
  const pageId = page.pageId.toLocaleLowerCase()
  return STANDING_FACTS_PAGES.some((name) => path === name || `${pageId}.md` === name)
}

export const createRefusal = (
  path: string
): { readonly code: "invalid" | "blocked"; readonly message: string } | undefined => {
  if (!path.endsWith(".md"))
    return { code: "invalid", message: "Memory page paths must end in .md" }
  if (
    (posix.dirname(path) === PATH_SEGMENT.current && !isStandingFactsPage({ path, pageId: "" })) ||
    isReadme(path)
  )
    return {
      code: "blocked",
      message: "Memory pages can be created only inside an existing Memory folder"
    }
  return undefined
}

const STANDING_PAGE_LIMIT_CHARS = 9_000

const CONDENSE_BEFORE_FULL_AT_SHARE = 0.9
const CONDENSE_TO_SHARE_LEAVING_HEADROOM = 0.8

const RULES_PAGE_LIMIT_CHARS = 128 * 1024

export const corePageBudget = (page: {
  readonly path: string
  readonly pageId: string
}): number | undefined => {
  if (isStandingFactsPage(page)) return STANDING_PAGE_LIMIT_CHARS
  return isRulesPage(page.path) ? RULES_PAGE_LIMIT_CHARS : undefined
}

export const coreCondenseTarget = (budget: number): number =>
  Math.floor(budget * CONDENSE_TO_SHARE_LEAVING_HEADROOM)

export const coreNeedsCondensing = (chars: number, budget: number): boolean =>
  chars > Math.floor(budget * CONDENSE_BEFORE_FULL_AT_SHARE)

export const CORE_CONDENSE_ADVICE =
  "Condense wording first, then move project-specific, dated or rarely needed detail " +
  "to the page that owns it, leaving a short link. Keep every general fact and preference."

export const coreCondenseNotice = (page: {
  readonly path: string
  readonly chars: number
  readonly budget: number
  readonly target: number
}): string =>
  `- ${page.path}: ${page.chars} characters; it is sent to every run, whole up to ${page.budget}. ` +
  `Bring it to ${page.target} or fewer. ${CORE_CONDENSE_ADVICE}`

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
