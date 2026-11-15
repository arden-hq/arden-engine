import { createToolset } from "@arden-hq/loop"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it, vi } from "vitest"
import { makeMemoryCaptureBatches } from "../src/memory/capture-batches.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { MemoryCaptureStore } from "../src/persistence/memory/store.js"
import { startCaptureAfterCopies } from "../src/persistence/sqlite/memory-capture-positions.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { TranscriptQueries } from "../src/persistence/transcript/queries.js"
import { snapshotOf } from "../src/wiki/snapshot.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../src/wiki/authority.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { ownerEdit, withWikiRepository, wikiToolsOver } from "./fixtures/wiki-repository.js"
import { serverRunContext } from "./kit.js"
import type { Wiki } from "../src/wiki/service.js"

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

it("reads a backlog range once, after new work, and removes it as it is read", async () => {
  vi.stubEnv("ARDEN_CAPTURE_CATCH_UP", "5")
  const read = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const drainer = yield* drain()
      const chat = (yield* (yield* SessionStore).create({})).sessionId
      yield* turn(chat, "old-a")
      yield* turn(chat, "old-b")
      yield* startCaptureAfterCopies(sql, chat)
      yield* sql`INSERT INTO memory_capture_backlog VALUES (${chat}, 0, 3)`
      yield* turn(chat, "new-c")
      const first = yield* drainer
      const left = yield* sql`SELECT 1 FROM memory_capture_backlog`
      return { first, left: left.length, again: yield* drainer }
    })
  )
  vi.unstubAllEnvs()
  expect(read).toEqual({ first: ["new-c", "old-a", "old-b"], left: 0, again: [] })
})

const captureUpdate = (
  wiki: Wiki["Service"],
  expectedHead: string | null,
  edits: Parameters<Wiki["Service"]["update"]>[0]["edits"]
) =>
  wiki.update({
    edits,
    expectedHead: expectedHead ?? "",
    authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
    commit: {
      actor: "memory:capture",
      origin: { kind: "capture", sessionId: "s" },
      reason: "capture",
      replayKey: "batch"
    }
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
        captureUpdate(wiki, expectedHead, [
          { pageId: "a", content: a.content.replace("A1", mark), expectedVersion: versionOfA },
          { pageId: "b", content: b.content.replace("B1", mark), expectedVersion: b.version }
        ])
      )
    const landed = await patch(read).then(head)
    expect(await patch(read).then(head)).toBe(landed)
    await expect(patch(landed, (await pages())[0].version, "X3")).rejects.toThrow()
    expect((await pages()).map((page) => page.content.includes("X2"))).toEqual([true, true])
  })
})

it("replays a Capture patch set whose first save left out an unchanged page", async () => {
  await withWikiRepository(async ({ repository, wiki, save }) => {
    await save({ pageId: "a", path: "a.md", body: "A1\n", origin: ownerEdit })
    await save({ pageId: "b", path: "b.md", body: "B1\n", origin: ownerEdit })
    const head = () => Effect.runPromise(repository.currentRevision)
    const [read, [a, b]] = [
      await head(),
      await Effect.runPromise(Effect.all([wiki.read("a"), wiki.read("b")]))
    ]
    const patch = () =>
      Effect.runPromise(
        captureUpdate(wiki, read, [
          { pageId: "a", content: a.content.replace("A1", "A2"), expectedVersion: a.version },
          { pageId: "b", content: b.content, expectedVersion: b.version }
        ])
      )
    const landed = await patch().then(head)
    expect(await patch().then(head)).toBe(landed)
  })
})

it("names no single page in a conflict of a patch set", async () => {
  await withWikiRepository(async ({ wiki, save }) => {
    await save({ pageId: "a", path: "a.md", body: "A1\n", origin: ownerEdit })
    await save({ pageId: "b", path: "b.md", body: "B1\n", origin: ownerEdit })
    const [a, b] = await Effect.runPromise(Effect.all([wiki.read("a"), wiki.read("b")]))
    await save({ pageId: "b", path: "b.md", body: "B9\n", origin: ownerEdit })
    const error = await Effect.runPromise(
      Effect.flip(
        captureUpdate(wiki, a.repositoryHead, [
          { pageId: "a", content: a.content.replace("A1", "A2"), expectedVersion: a.version },
          { pageId: "b", content: b.content.replace("B1", "B2"), expectedVersion: b.version }
        ])
      )
    )
    expect([error.reason, error.pageId]).toEqual(["conflict", undefined])
  })
})

const CAPTURE_RUN = {
  run_context: {
    origin: { kind: "automation", automation_id: "builtin-memory-capture", occurrence_id: "o" },
    task: null
  },
  memory_capture_batch: {
    sessionId: "s",
    start: { _tag: "Beginning" },
    end: { _tag: "Beginning" },
    endMessageId: "m"
  }
}

it("applies a Capture patch again once the page has its old text again", async () => {
  await withWikiRepository(async ({ wiki, save }) => {
    await save({ pageId: "a", path: "a.md", body: "Status: open\n", origin: ownerEdit })
    const patch = () =>
      createToolset(wikiToolsOver(wiki, CAPTURE_RUN), { toJsonSchema: () => ({ type: "object" }) })(
        serverRunContext()
      ).execute({
        name: "wiki_patch_page",
        args: { path: "a.md", old_text: "open", new_text: "closed" },
        toolCallId: "p"
      })
    await patch()
    await save({ pageId: "a", path: "a.md", body: "Status: open\n", origin: ownerEdit })
    await patch()
    expect((await Effect.runPromise(wiki.read("a"))).content).toContain("Status: closed")
  })
})
