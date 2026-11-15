/** The page that holds the owner's retractions: what they asked Arden to forget. */
export const FORGOTTEN_PAGE_PATH = "forgotten.md"

/**
 * Whether a page is code-owned. Only the owner and Arden's own code write it, and no run is
 * sent it: it stays out of recall, search, embeddings, the Memory index, page lists and upkeep.
 */
export const isSystemPage = (path: string): boolean => path.toLowerCase() === FORGOTTEN_PAGE_PATH
