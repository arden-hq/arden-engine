import type { FreeSpacePage } from "../../src/persistence/spaces/store.js"
import { freeSpacePage } from "../../src/wiki/space-index.js"

export const freePage = (pageId: string, pagePath: string): FreeSpacePage => {
  const page = freeSpacePage([], { pageId, pagePath })
  if (page === undefined) throw new Error(`${pagePath} is not free with no other Space`)
  return page
}
