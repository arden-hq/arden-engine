import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedFileRepository, managedFileRepositoryNodeLayer } from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { expect, it } from "vitest"

import type { SpaceStore } from "../src/persistence/spaces/store.js"
import { commitWiki, createPage, ownerInApp, updatePage } from "../src/wiki/commit.js"
import { makeWikiForgetMethods } from "../src/wiki/forgotten.js"
import { formatWikiPage } from "../src/wiki/page.js"
import { partialService } from "./kit.js"
import { withoutSpaces } from "./fixtures/wiki-repository.js"

const LINE = "Sam lives in the old town by the river."
const TURN = { sessionId: "session-fixture", chat: "arden:session/chat~session-fixture" }
const spaces = partialService<SpaceStore["Service"]>("SpaceStore", {
  activeBindings: () => Effect.succeed([])
})
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
        yield* commitWiki(memory, { ...ownerInApp("seed"), expectedRevision: null }, [
          createPage("sam", "people/sam.md", content("sam", `${LINE}\n- Works at the bakery.\n`)),
          createPage("town", "places/town.md", content("town", `- ${LINE}\nTwo bridges.\n`))
        ])
        const commits = () => repository.history({ limit: null }).pipe(Effect.map((h) => h.length))
        const before = yield* commits()
        yield* makeWikiForgetMethods(repository, spaces).forget({
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
              reason: "put back",
              expectedRevision: yield* repository.currentRevision
            },
            [updatePage(town, content("town", `${LINE}\n`))]
          ).pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "saved" }))
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
      ) as Effect.Effect<{ commits: number; sam: string; town: string; putBack: string }>
    )
    expect(outcome.commits).toBe(1)
    expect(outcome.sam).not.toContain(LINE)
    expect(outcome.town).not.toContain(LINE)
    expect(outcome.putBack).toContain("entry 1 in forgotten.md")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
