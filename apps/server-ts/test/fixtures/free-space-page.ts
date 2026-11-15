import type { FreeSpacePage } from "../../src/persistence/spaces/store.js"
import { freeSpacePage } from "../../src/wiki/space-index.js"

/** A page checked against no other active Space, so it is always free. */
export const freePage = (pageId: string, pagePath: string): FreeSpacePage => {
  const page = freeSpacePage([], { pageId, pagePath })
  if (page === undefined) throw new Error(`${pagePath} is not free with no other Space`)
  return page
}
