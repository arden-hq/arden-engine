import { readdirSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedFileRepository, managedFileRepositoryNodeLayer } from "@arden-hq/revisions/effect"
import { Deferred, Effect, Layer } from "effect"
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
import { startMemoryContentSteps } from "../src/memory/content-steps.js"
import { RunQueries } from "../src/persistence/runs/queries.js"
import { spaceJobId } from "../src/persistence/space-job-id.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { spaceControlTools } from "../src/tools/space-controls.js"
import { wikiError } from "../src/wiki/errors.js"
import { Wiki } from "../src/wiki/service.js"
import { createSpaceWithPage, type WikiSpacePageInput } from "../src/wiki/space-page.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { withoutSpaces, namedTool, runRecord, toolContext } from "./fixtures/wiki-repository.js"
import { partialService, serverRunContext } from "./kit.js"

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

  it("lets a restored Space take a page another archived Space still names", async () => {
    const outcome = await withTempDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const spaces = yield* SpaceStore
        yield* insertSpace(sql, "a")
        yield* insertSpace(sql, "b")
        yield* spaces.bindPage("a", "page-a", "areas/made-up-a.md")
        yield* spaces.bindPage("b", "page-b", "areas/made-up-b.md")
        yield* archiveRow(sql, "a")
        yield* archiveRow(sql, "b")
        const restored = yield* spaces.restore("a", {
          pageId: "page-a",
          pagePath: "areas/made-up-b.md"
        })
        const stale = yield* spaces.get("b", true)
        return { restored: restored?.page_path ?? null, stale: stale?.page_path ?? null }
      })
    )
    expect(outcome).toEqual({ restored: "areas/made-up-b.md", stale: null })
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
    const outcome = await withSpacesAndWiki((methods, { spaces, sql, repository }) =>
      Effect.gen(function* () {
        const space = yield* spaces.create({ name: "Made-up garden" })
        const first = yield* methods.ensureSpacePage({ spaceId: space.space_id })
        const pageId = first?.space.page_id ?? ""
        yield* archiveRow(sql, space.space_id)
        const head = yield* repository.currentRevision
        const current = yield* repository.get(pageId)
        if (current === null) return yield* Effect.die(new Error("the Space page is missing"))
        yield* commitWiki(
          withoutSpaces(repository),
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

const reviewWakes = (sql: SqlClient.SqlClient, spaceId: string) =>
  sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM automation_event_queue
    WHERE task_id = ${spaceJobId(spaceId)}`.pipe(Effect.map((rows) => rows[0]?.n ?? 0))

describe("a Space is created with its page", () => {
  it("ends with its page where `home` says, and starts no Space review", async () => {
    const outcome = await withSpacesAndWiki((methods, { spaces, sql, listing }) =>
      Effect.gen(function* () {
        const created = yield* createSpaceWithPage(
          { spaces, wiki: methods },
          { name: "Made-up trip" },
          { home: "projects" }
        )
        const page = yield* listing.read(created.page_id ?? "")
        const [job] = yield* sql<{ readonly enabled: number }>`
          SELECT enabled FROM scheduled_tasks WHERE task_id = ${spaceJobId(created.space_id)}`
        return {
          path: created.page_path,
          stored: (yield* spaces.get(created.space_id))?.page_path,
          page: page.path,
          reviewReady: job?.enabled,
          wakes: yield* reviewWakes(sql, created.space_id)
        }
      })
    )
    expect(outcome).toEqual({
      path: "projects/made-up-trip.md",
      stored: "projects/made-up-trip.md",
      page: "projects/made-up-trip.md",
      reviewReady: 1,
      wakes: 0
    })
  })

  it("keeps the Space when its page cannot be made now", async () => {
    const outcome = await withTempDatabase(
      Effect.gen(function* () {
        const spaces = yield* SpaceStore
        const created = yield* createSpaceWithPage(
          {
            spaces,
            wiki: {
              ensureSpacePage: () => Effect.fail(wikiError("create", "storage", "made-up failure"))
            }
          },
          { name: "Made-up trip" }
        )
        const stored = yield* spaces.get(created.space_id)
        return { stored: stored?.name, page: stored?.page_path ?? null }
      })
    )
    expect(outcome).toEqual({ stored: "Made-up trip", page: null })
  })

  it("two calls at once make one page", async () => {
    const outcome = await withSpacesAndWiki((methods, { spaces }) =>
      Effect.gen(function* () {
        const space = yield* spaces.create({ name: "Made-up garden" })
        const both = yield* Effect.all(
          [
            methods.ensureSpacePage({ spaceId: space.space_id }),
            methods.ensureSpacePage({ spaceId: space.space_id })
          ],
          { concurrency: "unbounded" }
        )
        return {
          made: both.filter((ensured) => ensured?.created !== undefined).length,
          samePage: both[0]?.space.page_id === both[1]?.space.page_id
        }
      })
    )
    expect(outcome).toEqual({ made: 1, samePage: true })
  })

  it("space_create passes the page's home through", async () => {
    const asked: Array<WikiSpacePageInput> = []
    await withTempDatabase(
      Effect.gen(function* () {
        const tools = yield* spaceControlTools.pipe(
          Effect.provideService(
            Wiki,
            partialService<Wiki["Service"]>("Wiki", {
              ensureSpacePage: (input) =>
                Effect.sync(() => {
                  asked.push(input)
                  return undefined
                })
            })
          ),
          Effect.provideService(
            RunQueries,
            partialService<RunQueries["Service"]>("RunQueries", {
              get: () => Effect.succeed(runRecord),
              liveness: () => Effect.succeed("turn")
            })
          ),
          Effect.provideService(WorkStore, partialService<WorkStore["Service"]>("WorkStore", {}))
        )
        const output = yield* Effect.promise(() =>
          namedTool(tools, "space_create").execute(
            { name: "Made-up trip", home: "projects" },
            toolContext(
              serverRunContext({ sessionId: runRecord.sessionId, runId: runRecord.runId })
            )
          )
        )
        expect(output.is_error).not.toBe(true)
      })
    )
    expect(asked.map((input) => input.home)).toEqual(["projects"])
  })
})

describe("the start check", () => {
  it("gives Spaces their pages after the content steps, even when those fail", async () => {
    const calls: Array<string> = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const checked = yield* Deferred.make<void>()
        yield* startMemoryContentSteps({
          wiki: {
            applyContentStep: () =>
              Effect.sync(() => calls.push("content step")).pipe(
                Effect.andThen(Effect.fail(wikiError("update", "storage", "made-up failure")))
              ),
            ensureSpacePages: () =>
              Effect.sync(() => calls.push("space pages")).pipe(
                Effect.andThen(Deferred.succeed(checked, undefined)),
                Effect.as({ active: 0, kept: 0, rebound: 0, made: 0, failed: 0 })
              )
          },
          sessions: partialService("Sessions", {}),
          transcript: partialService("Transcript", {})
        })
        yield* Deferred.await(checked).pipe(Effect.timeout("5 seconds"))
      }).pipe(Effect.scoped)
    )
    expect(calls).toEqual(["content step", "space pages"])
  })
})

describe("a Space worker's chat name", () => {
  const chatName = (sql: SqlClient.SqlClient, spaceId: string) =>
    sql<{ readonly job: string; readonly chat: string | null }>`
      SELECT job.name AS job, chat.name AS chat FROM scheduled_tasks AS job
      LEFT JOIN sessions AS chat ON chat.session_id = job.thread_id
      WHERE job.task_id = ${spaceJobId(spaceId)}`.pipe(Effect.map((rows) => rows[0]))

  it("follows the Space's name, and keeps a name the owner gave it", async () => {
    const outcome = await withTempDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const spaces = yield* SpaceStore
        const followed = yield* spaces.create({ name: "Made-up one" })
        const kept = yield* spaces.create({ name: "Made-up two" })
        yield* spaces.bindPage(followed.space_id, "page-one", "areas/made-up-one.md")
        yield* spaces.bindPage(kept.space_id, "page-two", "areas/made-up-two.md")
        yield* sql`UPDATE sessions SET name = 'My own name'
          WHERE session_id = (SELECT thread_id FROM scheduled_tasks
            WHERE task_id = ${spaceJobId(kept.space_id)})`
        yield* spaces.update(followed.space_id, { name: "Made-up first" })
        yield* spaces.update(kept.space_id, { name: "Made-up second" })
        yield* spaces.bindPage(kept.space_id, "page-two", "areas/made-up-second.md")
        yield* spaces.update(kept.space_id, { name: "Made-up second" })
        return {
          followed: yield* chatName(sql, followed.space_id),
          kept: yield* chatName(sql, kept.space_id)
        }
      })
    )
    expect(outcome).toEqual({
      followed: { job: "Made-up first worker", chat: "Made-up first worker" },
      kept: { job: "Made-up second worker", chat: "My own name" }
    })
  })
})

it("renames a job's chat only through renameOwnedJob, besides the owner's own edits", () => {
  const root = join(import.meta.dirname, "../src/persistence/sqlite")
  const naming = readdirSync(root)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => /UPDATE sessions\s+SET name\b/u.test(readFileSync(join(root, name), "utf8")))
    .sort()
  expect(naming).toEqual(["automation-catalog-edit.ts", "job-labels.ts", "session-lifecycle.ts"])
})

it("makes a Space's page only at creation, at the start check and from the released app's route", () => {
  const root = join(import.meta.dirname, "../src")
  const sources = (directory: string): ReadonlyArray<string> =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return sources(path)
      return entry.name.endsWith(".ts") ? [path] : []
    })
  const callers = sources(root)
    .filter((path) => /\.ensureSpacePage\(/u.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(root.length + 1))
    .sort()
  expect(callers).toEqual(["http/spaces/handlers.ts", "wiki/space-page.ts"])
})
