import { DateTime, Effect } from "effect"
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
        })
    },
    snapshot: () => Effect.succeed({ head: null, pages: [] }),
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

it("reads turns written after a clear, though their message numbers start again", async () => {
  const read = await withTempDatabase(
    Effect.gen(function* () {
      const { batches } = yield* capture()
      const sessions = yield* SessionStore
      const chat = yield* newChat()
      yield* turn(chat, "clear-a")
      yield* turn(chat, "clear-b")
      const before = yield* drain(batches)
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
