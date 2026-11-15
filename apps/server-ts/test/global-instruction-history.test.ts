import { Effect, Layer } from "effect"
import { readFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { expect, it } from "vitest"

import { rulesMoveLayer, rulesPage } from "../src/context/global-instructions.js"
import type { SpaceStore } from "../src/persistence/spaces/store.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY as authority } from "../src/wiki/authority.js"
import type { WikiCommitOrigin } from "../src/wiki/commit.js"
import { Wiki } from "../src/wiki/service.js"
import { makeOutsideEdits } from "../src/wiki/outside-edits.js"
import { partialService } from "./kit.js"
import { agentChat, withoutSpaces, withWikiRepository } from "./fixtures/wiki-repository.js"

const OWNER_TURN: WikiCommitOrigin = { kind: "rules", sessionId: "session-1" }
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const by = (origin: WikiCommitOrigin) => ({ actor: "user:chat", origin, reason: "rules" })

it("keeps each writer of the rules in page history, takes in an outside edit, and restores", async () => {
  await withWikiRepository(async ({ repository, workingRoot, wiki }) => {
    const current = async () => {
      const snapshot = await run(wiki.snapshot())
      const page = rulesPage(snapshot)
      if (page === undefined || snapshot.head === null) throw new Error("no rules page")
      const at = { expectedVersion: page.resource.versionId, expectedHead: snapshot.head }
      return { pageId: page.page.pageId, page: page.page, at }
    }
    const change = async (body: string, origin: WikiCommitOrigin) => {
      const { pageId, page, at } = await current()
      const content = page.content.replace(page.body, body)
      const edits = [{ pageId, content, ...at }] as const
      return run(wiki.update({ edits, ...at, authority, commit: by(origin) }))
    }
    const moved = join(workingRoot, "..", `${basename(workingRoot)}-AGENTS.md`)
    await writeFile(moved, "Rule one.\n")
    await run(
      Layer.build(rulesMoveLayer(moved)).pipe(Effect.scoped, Effect.provideService(Wiki, wiki))
    )
    await expect(readFile(moved)).rejects.toThrow()
    await change("Rule one.\nRule two.\n", OWNER_TURN)
    await expect(change("An assistant's own rule.\n", agentChat("session-1"))).rejects.toThrow()
    const file = join(workingRoot, "AGENTS.md")
    await writeFile(file, (await readFile(file, "utf8")).replace("two", "three, in an editor"))
    const { spaces } = withoutSpaces(repository)
    const store = partialService<SpaceStore["Service"]>("SpaceStore", spaces)
    const outside = makeOutsideEdits({ repository, spaces: store, snapshot: wiki.snapshot })
    await run(outside.check())
    expect((await run(outside.check())).takenIn.map((item) => item.path)).toEqual(["AGENTS.md"])
    const { pageId, at } = await current()
    const commitId = (await run(wiki.history(pageId))).commits.at(-1)?.commitId ?? ""
    const version = { commitId, side: "after" } as const
    await run(wiki.restore({ pageId, version, ...at, authority, commit: by(OWNER_TURN) }))
    const origins = (await run(wiki.history(pageId))).commits.map((entry) => entry.origin)
    const [chat, inFile] = ["memory.rules@session-1", "filesystem"]
    expect(origins).toEqual([chat, inFile, chat, inFile])
    expect((await current()).page.body).toBe("Rule one.\n")
  })
})
