import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ManagedFileRepository,
  managedFileRepositoryNodeLayer,
  type ManagedFileRepositoryShape
} from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { expect, it } from "vitest"

import { StoreInvalid, wikiErrorToHttp } from "../src/http/errors.js"
import type { PersistedSpace, SpaceStore } from "../src/persistence/spaces/store.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY as GLOBAL } from "../src/wiki/authority.js"
import { commitWiki, createPage, updatePage } from "../src/wiki/commit.js"
import { ownerInApp } from "../src/wiki/origin.js"
import { mapRevisionError } from "../src/wiki/errors.js"
import { makeWikiForgetMethods } from "../src/wiki/forgotten.js"
import { makeWikiListingMethods } from "../src/wiki/listing.js"
import { makeWikiChanges } from "../src/wiki/page-change.js"
import { formatWikiPage } from "../src/wiki/page.js"
import { partialService } from "./kit.js"
import { withoutSpaces } from "./fixtures/wiki-repository.js"

const LINE = "Sam lives in the old town by the river."
const TURN = {
  sessionId: "session-fixture",
  chat: "arden:session/chat~session-fixture",
  authority: GLOBAL
}
const spaces = partialService<SpaceStore["Service"]>("SpaceStore", {
  activeBindings: () => Effect.succeed([])
})
const forgetting = (repository: ManagedFileRepositoryShape, store: SpaceStore["Service"]) =>
  makeWikiChanges({ repository, spaces: store }, makeWikiListingMethods(repository).read)
const content = (pageId: string, body: string) =>
  formatWikiPage({
    pageId,
    title: pageId,
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: {},
    body
  })

it("forgetting a line removes every copy on every page in one commit, and no other writer may put it back", async () => {
  const root = await mkdtemp(join(tmpdir(), "arden-forget-"))
  try {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        const memory = withoutSpaces(repository)
        yield* commitWiki(
          memory,
          { ...ownerInApp("seed"), authority: GLOBAL, expectedRevision: null },
          [
            createPage("sam", "people/sam.md", content("sam", `${LINE}\n- Works at the bakery.\n`)),
            createPage("town", "places/town.md", content("town", `- ${LINE}\nTwo bridges.\n`))
          ]
        )
        const commits = () => repository.history({ limit: null }).pipe(Effect.map((h) => h.length))
        const before = yield* commits()
        yield* makeWikiForgetMethods(forgetting(repository, spaces)).forget({
          lines: [LINE],
          claim: "Sam does not live in the old town",
          turn: TURN
        })
        const body = (path: string) =>
          repository.findByPath(path).pipe(
            Effect.flatMap((page) =>
              page === null ? Effect.die(`${path} is missing`) : repository.readVersion(page)
            ),
            Effect.map((bytes) => new TextDecoder().decode(bytes))
          )
        const putBack = Effect.gen(function* () {
          const town = yield* repository.findByPath("places/town.md")
          if (town === null) throw new Error("places/town.md is missing")
          return yield* commitWiki(
            memory,
            {
              actor: "test",
              origin: { kind: "agent", sessionId: "chat-1" },
              authority: GLOBAL,
              reason: "put back",
              expectedRevision: yield* repository.currentRevision
            },
            [updatePage(town, content("town", `${LINE}\n`))]
          ).pipe(
            Effect.match({
              onFailure: (error) => wikiErrorToHttp(mapRevisionError("update")(error)),
              onSuccess: () => "saved"
            })
          )
        })
        return {
          commits: (yield* commits()) - before,
          sam: yield* body("people/sam.md"),
          town: yield* body("places/town.md"),
          putBack: yield* putBack
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root }))
      ) as Effect.Effect<{ commits: number; sam: string; town: string; putBack: unknown }>
    )
    expect(outcome.commits).toBe(1)
    expect(outcome.sam).not.toContain(LINE)
    expect(outcome.town).not.toContain(LINE)
    expect(outcome.putBack).toBeInstanceOf(StoreInvalid)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("a forget is refused outside the Space boundary of the run that asks for it", async () => {
  const root = await mkdtemp(join(tmpdir(), "arden-forget-"))
  try {
    const sam: Partial<PersistedSpace> = {
      space_id: "a",
      page_id: "sam",
      page_path: "people/sam.md"
    }
    const space = partialService<SpaceStore["Service"]>("SpaceStore", {
      activeBindings: () => Effect.succeed([]),
      get: () => Effect.succeed(sam as PersistedSpace)
    })
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ManagedFileRepository
        const seed = { ...ownerInApp("seed"), authority: GLOBAL, expectedRevision: null }
        yield* commitWiki(withoutSpaces(repository), seed, [
          createPage("sam", "people/sam.md", content("sam", `${LINE}\nA baker.\n`)),
          createPage("town", "places/town.md", content("town", `${LINE}\nTwo bridges.\n`))
        ])
        return yield* makeWikiForgetMethods(forgetting(repository, space))
          .forget({
            lines: [LINE],
            claim: "Sam does not live in the old town",
            turn: { ...TURN, authority: { _tag: "Space", spaceId: "a" } }
          })
          .pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "forgotten" }))
      }).pipe(
        Effect.scoped,
        Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: root }))
      ) as Effect.Effect<string>
    )
    expect(outcome).toBe("blocked")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
