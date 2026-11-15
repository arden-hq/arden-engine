import { Effect } from "effect"
import { expect, it } from "vitest"
import { renderSpaceContext, type SpaceView } from "../src/context/space-render.js"
import { MEMORY_BUDGET } from "../src/context/memory-context.js"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import { renderIndex } from "../src/memory/index-render.js"
import { snapshotOf, type PageRecord } from "../src/wiki/snapshot.js"

const view = (page: SpaceView["page"]): SpaceView => ({
  space_id: "space-garden",
  name: "Garden",
  instructions: undefined,
  isConversation: false,
  chats: [],
  page,
  questions: [],
  tasks: []
})

const shares = { maxBytes: 10_000, instructionsBytes: 4_000, pageBytes: 4_000 }

it("says how much of the Space memory page a chat is sent: whole, in part, or none", () => {
  const short = { path: "projects/garden.md", content: "Seeds ordered." }
  const long = { ...short, content: "A line about the garden.\n".repeat(400) }
  expect(renderSpaceContext(view(short), shares).page).toBe("whole")
  const partial = renderSpaceContext(view(long), shares)
  expect(partial.page).toBe("cut")
  expect(partial.text).toContain("The page continues")
  expect(renderSpaceContext(view(undefined), shares).page).toBe(undefined)
  // No room left for the page at all.
  expect(renderSpaceContext(view(short), { ...shares, maxBytes: 200 }).page).toBe("dropped")
})

const record = (path: string): PageRecord => ({
  resource: {
    resourceId: `id-${path}`,
    path,
    blobId: `blob-${path}`,
    state: "active",
    versionId: `version-${path}`
  },
  page: Effect.runSync(
    parseWikiPage(
      formatWikiPage({
        pageId: `id-${path}`,
        title: path,
        aliases: [],
        lifecycle: "active",
        redirectTo: null,
        metadata: {},
        body: `A made-up summary line for ${path}.`
      }),
      `id-${path}`
    )
  )
})

it("keeps the list of the Space's pages within its own allowance, and says when it is cut", () => {
  const own = record("areas/garden.md")
  const pages = [
    own,
    ...Array.from({ length: 300 }, (_, n) => record(`areas/garden/bed-${n}/plan.md`))
  ]
  const ref = { pageId: own.page.pageId, pagePath: own.resource.path }
  const shown = renderIndex(
    snapshotOf(null, pages).pages,
    { kind: "space", space: ref },
    MEMORY_BUDGET.space_page_list
  )
  expect(shown.sources).toEqual([
    expect.objectContaining({ kind: "index", outcome: "cut", reason: "index_allowance" })
  ])
  expect(shown.text).toContain("[Folded to fit: a folder marked folded")
  expect(shown.text).toContain("[Cut to fit: the last lines are left out")
  expect(new TextEncoder().encode(shown.text ?? "").byteLength).toBeLessThanOrEqual(
    MEMORY_BUDGET.space_page_list
  )
})
