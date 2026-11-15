import { Effect } from "effect"
import { expect, it } from "vitest"
import type { SpaceBindingRow } from "../src/persistence/spaces/store.js"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import { planSpacePage, spaceBinding, spaceOwnsPath } from "../src/wiki/space-index.js"
import { runPage } from "./kit.js"

const page = (path: string, options: { state?: "active" | "archived"; pageId?: string } = {}) => {
  const pageId = options.pageId ?? `id-${path}`
  return runPage({
    resource: {
      resourceId: pageId,
      path,
      blobId: `blob-${path}`,
      state: options.state ?? "active",
      versionId: `version-${path}`
    },
    page: Effect.runSync(
      parseWikiPage(
        formatWikiPage({
          pageId,
          title: path,
          aliases: [],
          lifecycle: "active",
          redirectTo: null,
          metadata: {},
          body: "x"
        }),
        pageId
      )
    )
  })
}

const row = (path: string | null, pageId = `id-${path}`): SpaceBindingRow => ({
  space_id: "a",
  page_id: path === null ? null : pageId,
  page_path: path
})

it("a Space keeps its page while free, rebinds a renamed one, and makes a fresh one otherwise", () => {
  const pages = [
    page("areas/garden.md"),
    page("areas/moved.md", { pageId: "renamed" }),
    page("areas/gone.md", { state: "archived" })
  ]
  const other = (path: string) => [spaceBinding({ ...row(path), space_id: "b" })]
  expect(planSpacePage(pages, row("areas/garden.md"), []).kind).toBe("keep")
  expect(planSpacePage(pages, row("areas/old.md", "renamed"), []).kind).toBe("rebind")
  for (const [path, held] of [
    [null, []],
    ["areas/gone.md", []],
    ["areas/garden.md", other("areas/garden.md")],
    ["areas/garden.md", other("areas/garden/x.md")]
  ] as const)
    expect(planSpacePage(pages, row(path), held).kind).toBe("create")
})
