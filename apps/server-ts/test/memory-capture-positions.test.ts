import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { DateTime, Effect, Exit } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import {
  makeMemoryCaptureBatches,
  type MemoryCaptureBatches
} from "../src/memory/capture-batches.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { ContextCompactionStore } from "../src/persistence/compaction/store.js"
import { MemoryCaptureStore, type MemoryCaptureBatch } from "../src/persistence/memory/store.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { SESSION_HANDOFF_MARKER } from "../src/persistence/transcript/model.js"
import { TranscriptQueries } from "../src/persistence/transcript/queries.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// Every turn the owner writes in a chat is read by Memory Capture once, whatever
// happens to the chat after it. Real stores on a temporary database; the wiki is a
// fake that only keeps capture receipts. "Read" is what Capture was handed.

const AT = "2026-11-14T09:00:00.000Z"

const capture = Effect.fn("capture")(function* (receipts = new Set<string>()) {
  const batches = makeMemoryCaptureBatches({
    wiki: {
      hasFinalizedCaptureBatch: (identity) =>
        Effect.succeed(receipts.has(JSON.stringify(identity))),
      finalizeCaptureBatch: (identity) =>
        Effect.sync(() => {
          receipts.add(JSON.stringify(identity))
        }),
      snapshot: () => Effect.succeed({ head: null, pages: [] })
    },
    captures: yield* MemoryCaptureStore,
    sessions: yield* SessionQueries,
    transcript: yield* TranscriptQueries
  })
  return { batches, receipts }
})

/** Runs Capture until it is idle and returns the owner messages it was handed. */
const drain = Effect.fn("drain")(function* (batches: MemoryCaptureBatches) {
  const read: Array<string> = []
  for (let round = 0; round < 50; round += 1) {
    const batch = yield* batches.nextCaptureBatch()
    if (batch === null) return read
    read.push(...ownerLines(batch))
    yield* batches.completeCaptureBatch(batch)
  }
  throw new Error("Capture did not become idle")
})

const ownerLines = (batch: MemoryCaptureBatch): ReadonlyArray<string> =>
  batch.markdown.split("\n").flatMap((line) => {
    const match = /^> \[user; sequence \d+; .*\] (\S+)$/u.exec(line)
    return match?.[1] === undefined ? [] : [match[1]]
  })

const start = Effect.fn("start")(function* (sessionId: string, id: string) {
  const chat = yield* ChatWriteStore
  const started = yield* chat.start({
    sessionId,
    clientId: id,
    requestHash: id,
    assistantMessageId: `${id}-answer`,
    message: { message_id: id, client_id: id, role: "user", content: id, created_at: AT }
  })
  if (started._tag !== "Started") throw new Error(`Turn ${id} did not start: ${started._tag}`)
  return started
})

/** One finished turn: the owner writes `id`, the assistant answers. */
const turn = Effect.fn("turn")(function* (sessionId: string, id: string) {
  const chat = yield* ChatWriteStore
  const started = yield* start(sessionId, id)
  yield* chat.finish({
    runId: started.runId,
    messages: [
      ...started.activeMessages,
      { message_id: `${id}-answer`, role: "assistant", content: `Noted ${id}`, created_at: AT }
    ]
  })
})

const compact = Effect.fn("compact")(function* (sessionId: string) {
  const compaction = yield* ContextCompactionStore
  const snapshot = yield* compaction.snapshot({ sessionId })
  const first = snapshot.messages[0]
  const last = snapshot.messages.at(-1)
  if (first === undefined || last === undefined) throw new Error("Nothing to compact")
  const messageId = `handoff-${snapshot.contextGeneration}`
  const createdAt = yield* DateTime.now
  const content = `${SESSION_HANDOFF_MARKER}\nSummary`
  yield* compaction.commit({
    sessionId,
    expectedContextGeneration: snapshot.contextGeneration,
    expectedContextVersion: snapshot.contextVersion,
    handoff: {
      messageId,
      role: "assistant",
      envelope: {
        message_id: messageId,
        role: "assistant",
        created_at: DateTime.formatIso(createdAt),
        content,
        compaction: {
          compaction_id: messageId,
          kind: "session_handoff",
          message_start_id: first.message_id,
          message_end_id: last.message_id,
          reason: "manual",
          messages_before: snapshot.messages.length,
          messages_after: 1,
          preserved_tail_ids: [],
          rehydration: null
        }
      },
      clientId: null,
      createdAt,
      searchText: "Summary",
      compaction: {
        compactionId: messageId,
        kind: "session_handoff",
        messageStartId: first.message_id,
        messageEndId: last.message_id,
        reason: "manual",
        messagesBefore: snapshot.messages.length,
        messagesAfter: 1,
        preservedTailIds: [],
        rehydrationState: null
      }
    }
  })
})

const newChat = Effect.fn("newChat")(function* () {
  const sessions = yield* SessionStore
  return (yield* sessions.create({})).sessionId
})

it("reads a turn after its chat is compacted", async () => {
  const read = await withTempDatabase(
    Effect.gen(function* () {
      const { batches } = yield* capture()
      const chat = yield* newChat()
      yield* turn(chat, "compaction-before")
      yield* compact(chat)
      return yield* drain(batches)
    })
  )
  expect(read).toEqual(["compaction-before"])
})

it("reads a turn after a long gap and a compaction, however many came after it", async () => {
  const read = await withTempDatabase(
    Effect.gen(function* () {
      const { batches } = yield* capture()
      const chat = yield* newChat()
      yield* turn(chat, "gap-first")
      const first = yield* drain(batches)
      yield* compact(chat)
      const later = Array.from({ length: 100 }, (_, index) => `gap-${index}`)
      for (const id of later) yield* turn(chat, id)
      return { first, later: yield* drain(batches) }
    })
  )
  expect(read).toEqual({
    first: ["gap-first"],
    later: Array.from({ length: 100 }, (_, index) => `gap-${index}`)
  })
})

// Clear deletes the chat's messages. Whether clear also means "forget" is the owner's open
// decision, so this pins today's behavior: what Capture read before the clear stays in Memory,
// a turn it had not read yet is gone with the messages, and turns after the clear are read.
it("keeps turns read before a clear, loses unread turns it deletes, and reads turns after it", async () => {
  const read = await withTempDatabase(
    Effect.gen(function* () {
      const { batches } = yield* capture()
      const sessions = yield* SessionStore
      const chat = yield* newChat()
      yield* turn(chat, "clear-a")
      yield* turn(chat, "clear-b")
      const before = yield* drain(batches)
      yield* turn(chat, "clear-unread")
      yield* sessions.clear(chat)
      yield* turn(chat, "clear-c")
      return { before, after: yield* drain(batches) }
    })
  )
  expect(read).toEqual({ before: ["clear-a", "clear-b"], after: ["clear-c"] })
})

it("reads a turn in a chat archived before Capture reached it", async () => {
  const read = await withTempDatabase(
    Effect.gen(function* () {
      const { batches } = yield* capture()
      const sessions = yield* SessionStore
      const chat = yield* newChat()
      yield* turn(chat, "archive-before")
      yield* sessions.archive(chat)
      return yield* drain(batches)
    })
  )
  expect(read).toEqual(["archive-before"])
})

it("never reads a reverted turn, and reads the turn that reuses its numbers once", async () => {
  const read = await withTempDatabase(
    Effect.gen(function* () {
      const { batches } = yield* capture()
      const sessions = yield* SessionStore
      const chat = yield* newChat()
      yield* turn(chat, "revert-a")
      yield* turn(chat, "revert-b")
      const first = yield* drain(batches)
      yield* sessions.revert({ sessionId: chat, turns: 1 })
      yield* turn(chat, "revert-c")
      yield* turn(chat, "revert-unread")
      yield* sessions.revert({ sessionId: chat, turns: 1 })
      const second = yield* drain(batches)
      yield* turn(chat, "revert-d")
      return { first, second, third: yield* drain(batches) }
    })
  )
  expect(read).toEqual({
    first: ["revert-a", "revert-b"],
    second: ["revert-c"],
    third: ["revert-d"]
  })
})

it("reads a batch's turns once when a later turn of it is reverted while it runs", async () => {
  const read = await withTempDatabase(
    Effect.gen(function* () {
      const { batches } = yield* capture()
      const sessions = yield* SessionStore
      const chat = yield* newChat()
      yield* turn(chat, "inflight-a")
      yield* turn(chat, "inflight-b")
      const handed = yield* batches.nextCaptureBatch()
      if (handed === null) throw new Error("Capture was handed nothing")
      yield* sessions.revert({ sessionId: chat, turns: 1 })
      yield* batches.completeCaptureBatch(handed)
      yield* turn(chat, "inflight-c")
      return { handed: ownerLines(handed), after: yield* drain(batches) }
    })
  )
  expect(read).toEqual({ handed: ["inflight-a", "inflight-b"], after: ["inflight-c"] })
})

it("drops a running batch whose every turn is reverted, and reads what replaces them", async () => {
  const read = await withTempDatabase(
    Effect.gen(function* () {
      const { batches } = yield* capture()
      const sessions = yield* SessionStore
      const chat = yield* newChat()
      yield* turn(chat, "gone-a")
      yield* drain(batches)
      yield* turn(chat, "gone-b")
      const handed = yield* batches.nextCaptureBatch()
      if (handed === null) throw new Error("Capture was handed nothing")
      yield* sessions.revert({ sessionId: chat, turns: 1 })
      yield* batches.completeCaptureBatch(handed)
      yield* turn(chat, "gone-c")
      return { handed: ownerLines(handed), after: yield* drain(batches) }
    })
  )
  expect(read).toEqual({ handed: ["gone-b"], after: ["gone-c"] })
})

it("resumes a batch cut by a revert with only the turns that are left", async () => {
  const read = await withTempDatabase(
    Effect.gen(function* () {
      const { batches, receipts } = yield* capture()
      const sessions = yield* SessionStore
      const chat = yield* newChat()
      yield* turn(chat, "cut-a")
      yield* turn(chat, "cut-b")
      const handed = yield* batches.nextCaptureBatch()
      if (handed === null) throw new Error("Capture was handed nothing")
      yield* sessions.revert({ sessionId: chat, turns: 1 })
      yield* turn(chat, "cut-c")
      const { batches: restarted } = yield* capture(receipts)
      const resumed = yield* restarted.nextCaptureBatch()
      if (resumed === null) throw new Error("The prepared batch was lost")
      yield* restarted.completeCaptureBatch(resumed)
      return { resumed: ownerLines(resumed), after: yield* drain(restarted) }
    })
  )
  expect(read).toEqual({ resumed: ["cut-a"], after: ["cut-c"] })
})

it("does not read a branch's copied turns again", async () => {
  const read = await withTempDatabase(
    Effect.gen(function* () {
      const { batches } = yield* capture()
      const sessions = yield* SessionStore
      const chat = yield* newChat()
      yield* turn(chat, "branch-a")
      yield* turn(chat, "branch-b")
      const source = yield* drain(batches)
      const branch = yield* sessions.branch(chat, {})
      if (branch === undefined) throw new Error("The chat did not branch")
      yield* sessions.completeBranchPreparation({ childSessionId: branch.sessionId })
      yield* turn(branch.sessionId, "branch-c")
      return { source, branch: yield* drain(batches) }
    })
  )
  expect(read).toEqual({ source: ["branch-a", "branch-b"], branch: ["branch-c"] })
})

/**
 * The working copy an Automation run makes of `source`: its messages, copied as a fork copies
 * them, then a turn the Automation ran in the copy.
 */
const automationCopy = Effect.fn("automationCopy")(function* (source: string) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO scheduled_tasks
    (task_id, automation_ref, name, prompt, triggers, created_at, thread_id)
    VALUES ('copy-automation', 'copy-automation-ref', 'Copy check', 'Check.', '[]', ${AT}, 'thread')`
  yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, metadata,
      origin_automation_id, parent_session_id, context_generation, active_message_count,
      visible_message_count, context_from_seq)
    SELECT 'copy', 'copy-ref', ${AT}, ${AT},
      json_object('fork_origin', json_object('sourceSessionId', session_id)), 'copy-automation',
      session_id, context_generation, active_message_count, visible_message_count,
      context_from_seq
    FROM sessions WHERE session_id = ${source}`
  yield* sql`INSERT INTO session_messages
      (session_id, message_id, seq, role, message_json, client_id, created_at, search_text)
    SELECT 'copy', message_id, seq, role, json_set(message_json, '$.forked_from', session_id),
      client_id, created_at, search_text
    FROM session_messages WHERE session_id = ${source}`
  yield* turn("copy", "copy-automation-turn")
  return "copy"
})

it("does not read the copies when an Automation's working copy continues as a chat", async () => {
  const read = await withTempDatabase(
    Effect.gen(function* () {
      const { batches } = yield* capture()
      const sessions = yield* SessionStore
      const chat = yield* newChat()
      yield* turn(chat, "copy-owner")
      const source = yield* drain(batches)
      const copy = yield* automationCopy(chat)
      yield* sessions.continueRun(copy)
      yield* turn(copy, "copy-own")
      return { source, copy: yield* drain(batches) }
    })
  )
  expect(read).toEqual({ source: ["copy-owner"], copy: ["copy-own"] })
})

it("gives every owner chat a place to start before it can hold a message", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const session = (sessionId: string, automationId: string | null) => sql`INSERT INTO sessions
          (session_id, public_ref, started_at, last_activity, origin_automation_id)
        VALUES (${sessionId}, ${`${sessionId}-ref`}, ${AT}, ${AT}, ${automationId})`
      yield* session("new-owner-chat", null)
      yield* session("held", "some-automation")
      yield* sql`INSERT INTO session_messages
          (session_id, message_id, seq, role, message_json, created_at, search_text)
        VALUES ('held', 'm', 0, 'user',
          json_object('message_id', 'm', 'role', 'user', 'content', 'm', 'created_at', ${AT}),
          ${AT}, 'm')`
      const becomesOwner = yield* Effect.exit(
        sql`UPDATE sessions SET origin_automation_id = NULL WHERE session_id = 'held'`
      )
      return {
        positions: yield* sql`SELECT session_id, read_seq FROM memory_capture_positions`,
        becomesOwner: Exit.isFailure(becomesOwner) ? "refused" : "kept"
      }
    })
  )
  expect(result).toEqual({
    positions: [{ session_id: "new-owner-chat", read_seq: -1 }],
    becomesOwner: "refused"
  })
})

const SOURCE = join(import.meta.dirname, "../src")

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })

it("copies messages from one chat into another only where Capture starts after the copies", () => {
  // A chat that is made an owner chat and then filled with copies starts at its beginning
  // (migration 0157), so the copies would be read again. The one copier writes the position
  // in the same step; a copy anywhere else fails here.
  const copiers = sources(SOURCE)
    .map((path) => relative(SOURCE, path))
    .filter((path) => !path.startsWith("persistence/migrations/"))
    .filter((path) =>
      /INSERT INTO session_messages\b[^`]*?\bFROM session_messages\b/u.test(
        readFileSync(join(SOURCE, path), "utf8")
      )
    )
  expect(copiers).toEqual(["persistence/sqlite/memory-capture-positions.ts"])
})

it("reads a turn that was stopped or failed with nothing after it", async () => {
  const read = await withTempDatabase(
    Effect.gen(function* () {
      const { batches } = yield* capture()
      const chat = yield* ChatWriteStore
      const stoppedChat = yield* newChat()
      const stopped = yield* start(stoppedChat, "stopped-turn")
      yield* chat.cancel({ runId: stopped.runId })
      const failedChat = yield* newChat()
      const failed = yield* start(failedChat, "failed-turn")
      yield* chat.fail({ runId: failed.runId, code: "runner_error", message: "Fixture failure" })
      return [...(yield* drain(batches))].sort()
    })
  )
  expect(read).toEqual(["failed-turn", "stopped-turn"])
})

it("waits while a turn runs, then reads it", async () => {
  const read = await withTempDatabase(
    Effect.gen(function* () {
      const { batches } = yield* capture()
      const chat = yield* ChatWriteStore
      const session = yield* newChat()
      const running = yield* start(session, "running-turn")
      const during = yield* drain(batches)
      yield* chat.finish({
        runId: running.runId,
        messages: [
          ...running.activeMessages,
          {
            message_id: "running-turn-answer",
            role: "assistant",
            content: "Noted",
            created_at: AT
          }
        ]
      })
      return { during, after: yield* drain(batches) }
    })
  )
  expect(read).toEqual({ during: [], after: ["running-turn"] })
})

it("resumes a prepared batch after a restart and writes it once", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const { batches, receipts } = yield* capture()
      const chat = yield* newChat()
      yield* turn(chat, "restart-a")
      const handed = yield* batches.nextCaptureBatch()
      if (handed === null) throw new Error("Capture was handed nothing")
      const { batches: restarted } = yield* capture(receipts)
      const resumed = yield* restarted.nextCaptureBatch()
      if (resumed === null) throw new Error("The prepared batch was lost")
      yield* restarted.completeCaptureBatch(resumed)
      yield* batches.completeCaptureBatch(handed)
      return {
        same: JSON.stringify(resumed.identity) === JSON.stringify(handed.identity),
        read: ownerLines(resumed),
        receipts: receipts.size,
        after: yield* drain(restarted)
      }
    })
  )
  expect(result).toEqual({ same: true, read: ["restart-a"], receipts: 1, after: [] })
})
