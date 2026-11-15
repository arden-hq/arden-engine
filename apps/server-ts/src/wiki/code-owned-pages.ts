/** The page that holds the owner's retractions: what they asked Arden to forget. */
export const FORGOTTEN_PAGE_PATH = "forgotten.md"

export const isCodeOwnedPage = (path: string): boolean => path.toLowerCase() === FORGOTTEN_PAGE_PATH
