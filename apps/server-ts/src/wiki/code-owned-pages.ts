import type { WikiCommitOrigin } from "./origin.js"

export const FORGOTTEN_PAGE_PATH = "forgotten.md"

export const RULES_PAGE_PATH = "AGENTS.md"
export const RULES_PAGE_TITLE = "Global instructions"

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

export const codeOwnedPage = (
  path: string
):
  | {
      readonly madeBy: WikiCommitOrigin["kind"]
      readonly holds: string
      readonly plainTitle?: string
    }
  | undefined => CODE_OWNED_PAGES.get(path.toLowerCase())

export const isCodeOwnedPage = (path: string): boolean => CODE_OWNED_PAGES.has(path.toLowerCase())

export const isRulesPage = (path: string): boolean =>
  path.toLowerCase() === RULES_PAGE_PATH.toLowerCase()
