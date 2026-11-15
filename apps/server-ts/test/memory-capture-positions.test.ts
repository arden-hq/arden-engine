import { Effect } from "effect"
import { expect, it } from "vitest"
import { makeMemoryCaptureBatches } from "../src/memory/capture-batches.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { MemoryCaptureStore } from "../src/persistence/memory/store.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { TranscriptQueries } from "../src/persistence/transcript/queries.js"
import { snapshotOf } from "../src/wiki/snapshot.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../src/wiki/authority.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { ownerEdit, withWikiRepository } from "./fixtures/wiki-repository.js"

const AT = "2026-11-14T09:00:00.000Z"

const turn = Effect.fn("turn")(function* (sessionId: string, id: string) {
  const chat = yield* ChatWriteStore
  const started = yield* chat.start({
    sessionId,
    clientId: id,
    requestHash: id,
    assistantMessageId: `${id}-answer`,
    message: { message_id: id, client_id: id, role: "user", content: id, created_at: AT }
  })
  if (started._tag !== "Started") throw new Error(`Turn ${id} did not start: ${started._tag}`)
  yield* chat.finish({
    runId: started.runId,
    messages: [
      ...started.activeMessages,
      { message_id: `${id}-answer`, role: "assistant", content: `Noted ${id}`, created_at: AT }
    ]
  })
})

/** Runs Capture until idle and returns the owner messages it was handed. */
const drain = Effect.fn("drain")(function* () {
  const receipts = new Set<string>()
  const batches = makeMemoryCaptureBatches({
    wiki: {
      hasFinalizedCaptureBatch: (identity) =>
        Effect.succeed(receipts.has(JSON.stringify(identity))),
      finalizeCaptureBatch: (identity) =>
        Effect.sync(() => void receipts.add(JSON.stringify(identity))),
      snapshot: () => Effect.succeed(snapshotOf(null, []))
    },
    captures: yield* MemoryCaptureStore,
    sessions: yield* SessionQueries,
    transcript: yield* TranscriptQueries
  })
  return Effect.gen(function* () {
    const read: Array<string> = []
    for (let round = 0; round < 50; round += 1) {
      const batch = yield* batches.nextCaptureBatch()
      if (batch === null) return read
      read.push(
        ...[...batch.markdown.matchAll(/^> \[user; sequence \d+; .*\] (\S+)$/gmu)].flatMap(
          (m) => m[1] ?? []
        )
      )
      yield* batches.completeCaptureBatch(batch)
    }
    throw new Error("Capture did not become idle")
  })
})

it("never reads a reverted turn, and reads the turn that reuses its numbers once", async () => {
  const read = await withTempDatabase(
    Effect.gen(function* () {
      const drainer = yield* drain()
      const sessions = yield* SessionStore
      const chat = (yield* sessions.create({})).sessionId
      yield* turn(chat, "revert-a")
      yield* turn(chat, "revert-b")
      const first = yield* drainer
      yield* sessions.revert({ sessionId: chat, turns: 1 })
      yield* turn(chat, "revert-c")
      yield* turn(chat, "revert-unread")
      yield* sessions.revert({ sessionId: chat, turns: 1 })
      const second = yield* drainer
      yield* turn(chat, "revert-d")
      return { first, second, third: yield* drainer }
    })
  )
  expect(read).toEqual({
    first: ["revert-a", "revert-b"],
    second: ["revert-c"],
    third: ["revert-d"]
  })
})

it("saves a Capture patch set once on replay, and none of it when one page conflicts", async () => {
  await withWikiRepository(async ({ repository, wiki, save }) => {
    await save({ pageId: "a", path: "a.md", body: "A1\n", origin: ownerEdit })
    await save({ pageId: "b", path: "b.md", body: "B1\n", origin: ownerEdit })
    const head = () => Effect.runPromise(repository.currentRevision)
    const pages = () => Effect.runPromise(Effect.all([wiki.read("a"), wiki.read("b")]))
    const [read, [a, b]] = [await head(), await pages()]
    const patch = (expectedHead: string | null, versionOfA = a.version, mark = "X2") =>
      Effect.runPromise(
        wiki.update({
          edits: [
            { pageId: "a", content: a.content.replace("A1", mark), expectedVersion: versionOfA },
            { pageId: "b", content: b.content.replace("B1", mark), expectedVersion: b.version }
          ],
          expectedHead: expectedHead ?? "",
          authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
          commit: {
            actor: "memory:capture",
            origin: { kind: "capture", sessionId: "s", replayKey: "batch" },
            reason: "capture"
          }
        })
      )
    const landed = await patch(read).then(head)
    expect(await patch(read).then(head)).toBe(landed)
    await expect(patch(landed, (await pages())[0].version, "X3")).rejects.toThrow()
    expect((await pages()).map((page) => page.content.includes("X2"))).toEqual([true, true])
  })
})
