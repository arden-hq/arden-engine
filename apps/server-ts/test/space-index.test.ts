import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedFileRepository, managedFileRepositoryNodeLayer } from "@arden-hq/revisions/effect"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { describe, expect, it } from "vitest"

import { SpaceStore, type SpaceBinding } from "../src/persistence/spaces/store.js"
import { archivePage } from "../src/wiki/commit.js"
import { makeWikiListingMethods } from "../src/wiki/listing.js"
import { makeWikiMutationMethods } from "../src/wiki/mutations.js"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import type { PageRecord } from "../src/wiki/snapshot.js"
import { commitWiki } from "../src/wiki/commit.js"
import {
  planSpacePage,
  spaceOwnsPath,
  spacePageIndex,
  spacePages
} from "../src/wiki/space-index.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const page = (
  path: string,
  options: { readonly state?: "active" | "archived"; readonly pageId?: string } = {}
): PageRecord => {
  const pageId = options.pageId ?? `id-${path}`
  return {
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
          body: `About ${path}.`
        }),
        pageId
      )
    )
  }
}

const binding = (spaceId: string, path: string | null, pageId = `id-${path}`): SpaceBinding => ({
  space_id: spaceId,
  page_id: path === null ? null : pageId,
  page_path: path
})

describe("which pages a Space owns", () => {
  const pages = [
    page("areas/garden.md"),
    page("areas/garden/beds.md"),
    page("areas/garden/seeds/list.md"),
    page("areas/garden/old.md", { state: "archived" }),
    page("areas/gardening.md"),
    page("areas/garden-2.md"),
    page("areas/kitchen/README.md"),
    page("areas/kitchen/pans.md")
  ]

  it("a single-file page heads the folder of its name, and a README heads its folder", () => {
    expect(
      spacePages(pages, { pageId: "id-areas/garden.md", pagePath: "areas/garden.md" }).map(
        (record) => record.resource.path
      )
    ).toEqual(["areas/garden.md", "areas/garden/beds.md", "areas/garden/seeds/list.md"])
    expect(
      spacePages(pages, {
        pageId: "id-areas/kitchen/README.md",
        pagePath: "areas/kitchen/README.md"
      }).map((record) => record.resource.path)
    ).toEqual(["areas/kitchen/README.md", "areas/kitchen/pans.md"])
    expect(spaceOwnsPath("areas/garden.md", "AREAS/Garden/new.md")).toBe(true)
    expect(spaceOwnsPath("areas/garden.md", "areas/gardening.md")).toBe(false)
  })

  it("lists every other page the Space owns, leaving out its own page, folder case aside", () => {
    const index = spacePageIndex(
      [...pages, page("areas/Garden/notes.md")],
      { pageId: "id-areas/garden.md", pagePath: "areas/garden.md" },
      10_000
    )
    expect(index.root).toBe("areas/garden")
    expect(index.lines.map((line) => line.path).sort()).toEqual([
      "areas/Garden/notes.md",
      "areas/garden/beds.md",
      "areas/garden/seeds/list.md"
    ])
    expect(index.unlisted).toBe(0)
    const own = spacePageIndex(
      pages,
      { pageId: "id-areas/kitchen/README.md", pagePath: "areas/kitchen/README.md" },
      10_000
    )
    expect(own.lines.map((line) => line.path)).toEqual(["areas/kitchen/pans.md"])
  })
})

describe("what gives an active Space its page", () => {
  const pages = [
    page("areas/garden.md"),
    page("areas/moved.md", { pageId: "renamed" }),
    page("areas/gone.md", { state: "archived" })
  ]

  it("keeps a page that is still there and free", () => {
    expect(planSpacePage(pages, binding("a", "areas/garden.md"), [])).toEqual({
      kind: "keep",
      pageId: "id-areas/garden.md",
      pagePath: "areas/garden.md"
    })
  })

  it("binds the page again at the path it was renamed to", () => {
    expect(planSpacePage(pages, binding("a", "areas/old-name.md", "renamed"), [])).toEqual({
      kind: "rebind",
      pageId: "renamed",
      pagePath: "areas/moved.md"
    })
  })

  it("makes a fresh page when there is none, it is gone, or another active Space holds it", () => {
    expect(planSpacePage(pages, binding("a", null), [])).toEqual({ kind: "create" })
    expect(planSpacePage(pages, binding("a", "areas/gone.md"), [])).toEqual({ kind: "create" })
    expect(planSpacePage(pages, binding("a", "areas/missing.md"), [])).toEqual({
      kind: "create"
    })
    expect(
      planSpacePage(pages, binding("a", "areas/garden.md"), [binding("b", "areas/garden.md")])
    ).toEqual({ kind: "create" })
    expect(
      planSpacePage(pages, binding("a", "areas/garden.md"), [binding("b", "areas/garden/x.md")])
    ).toEqual({ kind: "create" })
  })
})

const AT = "2026-11-01T00:00:00.000Z"
const insertSpace = (sql: SqlClient.SqlClient, spaceId: string) =>
  sql`INSERT INTO spaces (space_id, name, name_key, inference_policy, created_at, updated_at)
    VALUES (${spaceId}, ${`Made-up ${spaceId}`}, ${`made-up ${spaceId}`},
      ${JSON.stringify({ enabled: false })}, ${AT}, ${AT})`
const archiveRow = (sql: SqlClient.SqlClient, spaceId: string) =>
  sql`UPDATE spaces SET archived_at = ${AT} WHERE space_id = ${spaceId}`

describe("an archived Space releases its pages", () => {
  it("owns nothing, and another Space may take its page", async () => {
    const outcome = await withTempDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const spaces = yield* SpaceStore
        yield* insertSpace(sql, "a")
        yield* insertSpace(sql, "b")
        yield* spaces.bindPage("a", "page-a", "areas/made-up-a.md")
        const before = (yield* spaces.activeBindings()).map((row) => row.space_id)
        yield* archiveRow(sql, "a")
        const after = (yield* spaces.activeBindings()).map((row) => row.space_id)
        yield* spaces.bindPage("b", "page-a", "areas/made-up-a.md")
        const archived = yield* spaces.get("a", true)
        return { before, after, archived: archived?.page_path ?? null }
      })
    )
    expect(outcome).toEqual({ before: ["a"], after: [], archived: null })
  })
})

const withSpacesAndWiki = <A, E>(
  body: (
    methods: ReturnType<typeof makeWikiMutationMethods>,
    tools: {
      readonly spaces: SpaceStore["Service"]
      readonly sql: SqlClient.SqlClient
      readonly listing: ReturnType<typeof makeWikiListingMethods>
      readonly repository: ManagedFileRepository["Service"]
    }
  ) => Effect.Effect<A, E, SpaceStore | SqlClient.SqlClient | ManagedFileRepository>
) =>
  withDirectory(async (directory) =>
    withTempDatabase(
      Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        const spaces = yield* SpaceStore
        const sql = yield* SqlClient.SqlClient
        const listing = makeWikiListingMethods(repository)
        const methods = makeWikiMutationMethods(repository, spaces, listing.read)
        return yield* body(methods, { spaces, sql, listing, repository })
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.fresh(managedFileRepositoryNodeLayer({ workingRoot: directory })))
      )
    )
  )

const withDirectory = async <A>(use: (directory: string) => Promise<A>): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "arden-space-index-"))
  try {
    return await use(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("every active Space has a page", () => {
  it("makes and binds a page once, and a second call changes nothing", async () => {
    const outcome = await withSpacesAndWiki((methods, { spaces }) =>
      Effect.gen(function* () {
        const space = yield* spaces.create({ name: "Made-up garden" })
        const first = yield* methods.ensureSpacePage({ spaceId: space.space_id })
        const second = yield* methods.ensureSpacePage({ spaceId: space.space_id })
        return {
          path: first?.space.page_path,
          made: first?.created?.path,
          again: second?.space.page_path,
          madeAgain: second?.created
        }
      })
    )
    expect(outcome).toEqual({
      path: "areas/made-up-garden.md",
      made: "areas/made-up-garden.md",
      again: "areas/made-up-garden.md",
      madeAgain: undefined
    })
  })

  it("a restored Space whose page was archived meanwhile gets a fresh page", async () => {
    const outcome = await withSpacesAndWiki((methods, { spaces, sql, repository, listing }) =>
      Effect.gen(function* () {
        const space = yield* spaces.create({ name: "Made-up garden" })
        const first = yield* methods.ensureSpacePage({ spaceId: space.space_id })
        const pageId = first?.space.page_id ?? ""
        yield* archiveRow(sql, space.space_id)
        const head = yield* repository.currentRevision
        const current = yield* repository.get(pageId)
        if (current === null) return yield* Effect.die(new Error("the Space page is missing"))
        yield* commitWiki(
          repository,
          {
            expectedRevision: head,
            actor: "user:desktop",
            origin: { kind: "user", via: "desktop" },
            reason: "archive a released page"
          },
          [archivePage(current)]
        )
        const restored = yield* methods.restoreSpace(space.space_id)
        return {
          path: restored?.page_path,
          samePage: restored?.page_id === pageId
        }
      })
    )
    expect(outcome).toEqual({ path: "areas/made-up-garden.md", samePage: false })
  })

  it("a restored Space keeps a free page, and gets a fresh one when another Space overlaps it", async () => {
    const outcome = await withSpacesAndWiki((methods, { spaces, sql }) =>
      Effect.gen(function* () {
        const kept = yield* spaces.create({ name: "Made-up kept" })
        const taken = yield* spaces.create({ name: "Made-up taken" })
        const other = yield* spaces.create({ name: "Made-up other" })
        const keptPage = (yield* methods.ensureSpacePage({ spaceId: kept.space_id }))?.space
        const takenPage = (yield* methods.ensureSpacePage({ spaceId: taken.space_id }))?.space
        yield* archiveRow(sql, kept.space_id)
        yield* archiveRow(sql, taken.space_id)
        yield* spaces.bindPage(other.space_id, "inside", "areas/made-up-taken/inside.md")
        const keptAgain = yield* methods.restoreSpace(kept.space_id)
        const takenAgain = yield* methods.restoreSpace(taken.space_id)
        return {
          kept: keptAgain?.page_id === keptPage?.page_id,
          fresh: takenAgain?.page_id !== takenPage?.page_id,
          path: takenAgain?.page_path
        }
      })
    )
    expect(outcome).toEqual({ kept: true, fresh: true, path: "areas/made-up-taken-2.md" })
  })

  it("a restored Space whose page is taken and cannot get a fresh one comes back with none", async () => {
    const outcome = await withSpacesAndWiki((methods, { spaces, sql }) =>
      Effect.gen(function* () {
        const taken = yield* spaces.create({ name: "Made-up taken" })
        const other = yield* spaces.create({ name: "Made-up other" })
        yield* methods.ensureSpacePage({ spaceId: taken.space_id })
        yield* archiveRow(sql, taken.space_id)
        yield* spaces.bindPage(other.space_id, "areas-directory", "areas/README.md")
        const restored = yield* methods.restoreSpace(taken.space_id)
        return {
          active: restored?.archived_at === null,
          page: restored?.page_path ?? null,
          bindings: (yield* spaces.activeBindings()).map((row) => row.space_id)
        }
      })
    )
    expect(outcome.active).toBe(true)
    expect(outcome.page).toBeNull()
    expect(outcome.bindings).toHaveLength(1)
  })

  it("gives every active Space without a page one, and counts what it did", async () => {
    const outcome = await withSpacesAndWiki((methods, { spaces }) =>
      Effect.gen(function* () {
        const first = yield* spaces.create({ name: "Made-up one" })
        yield* spaces.create({ name: "Made-up two" })
        yield* methods.ensureSpacePage({ spaceId: first.space_id })
        const counts = yield* methods.ensureSpacePages()
        const again = yield* methods.ensureSpacePages()
        const bound = (yield* spaces.list()).filter((space) => space.page_path !== null).length
        return { counts, again, bound }
      })
    )
    expect(outcome).toEqual({
      counts: { active: 2, kept: 1, rebound: 0, made: 1, failed: 0 },
      again: { active: 2, kept: 2, rebound: 0, made: 0, failed: 0 },
      bound: 2
    })
  })
})

