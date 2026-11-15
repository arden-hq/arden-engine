import type { WikiCommitOrigin } from "./commit.js"

/** The page that holds the owner's retractions: what they asked Arden to forget. */
export const FORGOTTEN_PAGE_PATH = "forgotten.md"

/** The owner's standing rules, sent whole to every chat. A Local folder `AGENTS.md` is more specific. */
export const RULES_PAGE_PATH = "AGENTS.md"
export const RULES_PAGE_TITLE = "Global instructions"

/**
 * Each page Arden keeps for the owner: the writer that makes it, and what it is. A page whose body
 * holds all of it has `plainTitle`: a file of it with no frontmatter reads as its body.
 * `forgotten.md` keeps its entries in frontmatter, so a file of it without one does not read.
 */
const CODE_OWNED_PAGES: ReadonlyMap<
  string,
  {
    readonly madeBy: WikiCommitOrigin["kind"]
    readonly holds: string
    readonly plainTitle?: string
  }
> = new Map([
  [
    FORGOTTEN_PAGE_PATH,
    {
      madeBy: "forget",
      holds:
        "is where Arden keeps what the owner asked to forget. To let a line back, undo its entry in a chat or delete the entry from the page."
    }
  ],
  [
    RULES_PAGE_PATH.toLowerCase(),
    {
      madeBy: "user",
      holds: "holds the owner's standing rules, sent whole to every chat. Change the rules in it.",
      plainTitle: RULES_PAGE_TITLE
    }
  ]
])

export const codeOwnedPage = (path: string) => CODE_OWNED_PAGES.get(path.toLowerCase())

export const isCodeOwnedPage = (path: string): boolean => CODE_OWNED_PAGES.has(path.toLowerCase())

export const isRulesPage = (path: string): boolean =>
  path.toLowerCase() === RULES_PAGE_PATH.toLowerCase()
