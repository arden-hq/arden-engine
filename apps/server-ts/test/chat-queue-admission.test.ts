import { decodeServerEventStreamBuffer, encodeServerEventFrame } from "@arden-hq/protocol"
import { ChatEventStore } from "../src/persistence/events/store.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { ToolHistoryQueries } from "../src/persistence/tools/history-queries.js"
import { userContent } from "../src/persistence/transcript/user-content.js"
import { SqlClient } from "effect/unstable/sql"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { DeferredToolCalls } from "../src/persistence/tools/deferred.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { recoveredSqlitePersistenceLayer } from "../src/runtime/persistence-layer.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"

it("rolls back queue consumption on rejected admission and replays accepted admission after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-queue-admission-"))
  const layer = () =>
    recoveredSqlitePersistenceLayer({ dataDir: null, filename: join(directory, "arden.db") }).pipe(
      Layer.provide(PersistenceWriteQueue.layer)
    )
  try {
    const saved = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        const chat = yield* ChatWriteStore
        const session = yield* sessions.create({ name: "Parked input" })
        const queued = yield* chat.enqueue({
          sessionId: session.sessionId,
          clientId: "parked",
          message: "Keep this",
          images: []
        })
        const input = {
          sessionId: session.sessionId,
          clientId: "parked",
          requestHash: "parked-request",
          assistantMessageId: "answer",
          message: {
            message_id: "parked",
            client_id: "parked",
            role: "user" as const,
            content: "Keep this",
            created_at: new Date().toISOString()
          }
        }
        const rejected = yield* chat
          .start({ ...input, modelId: "missing/fixture-model" })
          .pipe(Effect.result)
        expect(rejected).toMatchObject({ _tag: "Failure", failure: { reason: "invalid" } })
        expect(yield* chat.listQueued(session.sessionId)).toEqual([queued])
        return { input, queued }
      }).pipe(Effect.provide(layer()))
    )
    const accepted = await Effect.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatWriteStore
        expect(yield* chat.listQueued(saved.input.sessionId)).toEqual([saved.queued])
        const result = yield* chat.start(saved.input)
        expect(result._tag).toBe("Started")
        expect(yield* chat.listQueued(saved.input.sessionId)).toEqual([])
        return result
      }).pipe(Effect.provide(layer()))
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatWriteStore
        expect(yield* chat.listQueued(saved.input.sessionId)).toEqual([])
        const replay = yield* chat.start(saved.input)
        expect(replay).toMatchObject({ _tag: "Existing", runId: accepted.runId })
        expect(yield* chat.listQueued(saved.input.sessionId)).toEqual([])
      }).pipe(Effect.provide(layer()))
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("denies one exact visible approval and admits its reason once", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const chat = yield* ChatWriteStore
      const tools = yield* ToolExecutionStore
      const sql = yield* SqlClient.SqlClient
      const work = yield* WorkStore
      const session = yield* sessions.create({ name: "Approval reply" })
      const other = yield* sessions.create({ name: "Other chat" })
      const task = yield* work.create(
        { kind: "chat", sessionId: session.sessionId },
        { key: "reply-task", text: "Protect the original files", runs_in: "chat" }
      )
      const run = yield* chat.start({
        continuesTask: { itemId: task.item_id },
        sessionId: session.sessionId,
        clientId: "start",
        requestHash: "start",
        assistantMessageId: "answer",
        message: {
          message_id: "start",
          client_id: "start",
          role: "user",
          content: "Work",
          created_at: "2026-10-28T00:00:00.000Z"
        }
      })
      const first = {
        runId: run.runId,
        sessionId: session.sessionId,
        toolCallId: "first",
        toolName: "file_write",
        arguments: { path: "/tmp/first" },
        changesState: false
      }
      const second = { ...first, toolCallId: "second" }
      const question = yield* work.askQuestion({
        runId: run.runId,
        toolCallId: "ask",
        content: { prompt: "Which destination?", detail: null, choices: [] }
      })
      yield* tools.begin(first)
      yield* tools.pause(first, { reason: "approval", preview: "Write first" })
      yield* tools.begin(second)
      yield* tools.pause(second, { reason: "approval", preview: "Write second" })
      const reply = {
        sessionId: session.sessionId,
        clientId: "reply",
        requestHash: "reply",
        assistantMessageId: "reply-answer",
        wake: true,
        approvalReply: { runId: run.runId, toolId: "first" },
        message: {
          message_id: "reply",
          client_id: "reply",
          role: "user" as const,
          content: "Keep the originals",
          created_at: "2026-10-28T00:01:00.000Z"
        }
      }
      expect(
        (yield* chat.receive({ ...reply, sessionId: other.sessionId }).pipe(Effect.result))._tag
      ).toBe("Failure")
      expect(
        (yield* chat.receive({ ...reply, modelId: "missing/fixture-model" }).pipe(Effect.result))
          ._tag
      ).toBe("Failure")
      expect(
        yield* sql`SELECT tool_call_id, status FROM tool_approvals WHERE run_id = ${run.runId} ORDER BY tool_call_id`
      ).toEqual([
        { tool_call_id: "first", status: "pending" },
        { tool_call_id: "second", status: "pending" }
      ])
      expect(yield* chat.receive(reply)).toEqual({ _tag: "Queued", runId: run.runId })
      expect(yield* chat.receive(reply)).toEqual({
        _tag: "Existing",
        runId: run.runId,
        status: "queued"
      })
      expect(
        yield* sql`SELECT tool_call_id, status, result_feedback FROM tool_approvals WHERE run_id = ${run.runId} ORDER BY tool_call_id`
      ).toEqual([
        { tool_call_id: "first", status: "rejected", result_feedback: null },
        { tool_call_id: "second", status: "pending", result_feedback: null }
      ])
      expect(
        yield* sql`SELECT resolution FROM run_questions WHERE question_id = ${question.question_id}`
      ).toEqual([{ resolution: null }])
      expect(yield* chat.claimResume(run.runId)).toBeNull()
      expect(
        (yield* chat.drainPending(run.runId)).map((message) => userContent(message.content).text)
      ).toEqual(["Keep the originals"])
      expect(yield* chat.drainPending(run.runId)).toEqual([])
      expect(
        (yield* chat
          .receive({
            ...reply,
            requestHash: "changed",
            approvalReply: { runId: run.runId, toolId: "second" }
          })
          .pipe(Effect.result))._tag
      ).toBe("Failure")
    })
  )
})

it("atomically denies a deferred card and admits one ordinary reason", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const chat = yield* ChatWriteStore
      const tools = yield* ToolExecutionStore
      const deferred = yield* DeferredToolCalls
      const sql = yield* SqlClient.SqlClient
      const session = yield* sessions.create({ name: "Deferred reply" })
      const run = yield* chat.start({
        sessionId: session.sessionId,
        clientId: "start",
        requestHash: "start",
        assistantMessageId: "answer",
        message: {
          message_id: "start",
          client_id: "start",
          role: "user",
          content: "Work",
          created_at: "2026-10-28T00:00:00.000Z"
        }
      })
      if (run._tag !== "Started") return yield* Effect.die("Run did not start")
      const call = {
        runId: run.runId,
        sessionId: session.sessionId,
        toolCallId: "deferred",
        toolName: "file_write",
        arguments: { path: "/tmp/file" },
        changesState: false,
        data: undefined
      }
      const { data: _data, ...identity } = call
      yield* tools.begin(identity)
      yield* deferred.defer({ call, prompt: { preview: "Write file" } })
      yield* tools.complete(identity, {
        content: "Approval requested",
        preview: "Approval requested",
        is_error: false
      })
      yield* chat.finish({
        runId: run.runId,
        messages: [
          ...run.activeMessages,
          {
            message_id: "answer",
            role: "assistant",
            content: "Please review the proposed action",
            created_at: "2026-10-28T00:00:30.000Z"
          }
        ]
      })
      const reply = {
        sessionId: session.sessionId,
        clientId: "reply",
        requestHash: "reply",
        assistantMessageId: "reply-answer",
        wake: true,
        approvalReply: { runId: run.runId, toolId: "deferred" },
        message: {
          message_id: "reply",
          client_id: "reply",
          role: "user" as const,
          content: "Keep the original",
          created_at: "2026-10-28T00:01:00.000Z"
        }
      }
      const admitted = yield* chat.receive(reply)
      expect(admitted._tag).toBe("Started")
      if (admitted._tag !== "Started")
        return yield* Effect.die("Reason did not start a continuation")
      expect(yield* chat.receive(reply)).toEqual({
        _tag: "Existing",
        runId: admitted.runId,
        status: "running"
      })
      expect(
        yield* sql`SELECT status, result_json FROM deferred_tool_calls WHERE run_id = ${run.runId}`
      ).toEqual([{ status: "rejected", result_json: null }])
      expect(
        admitted.activeMessages
          .filter((message) => message.client_id === "reply")
          .map((message) => userContent(message.content).text)
      ).toEqual(["Keep the original"])
      expect(
        yield* sql`SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ${session.sessionId} AND client_id = 'reply'`
      ).toEqual([{ count: 1 }])
    })
  )
})

it("replays an approval reply after reopening the database without denying its sibling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-approval-reply-"))
  const layer = () =>
    recoveredSqlitePersistenceLayer({ dataDir: null, filename: join(directory, "arden.db") }).pipe(
      Layer.provide(PersistenceWriteQueue.layer)
    )
  try {
    const saved = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        const chat = yield* ChatWriteStore
        const tools = yield* ToolExecutionStore
        const session = yield* sessions.create({ name: "Reply restart" })
        const run = yield* chat.start({
          sessionId: session.sessionId,
          clientId: "start",
          requestHash: "start",
          assistantMessageId: "answer",
          message: {
            message_id: "start",
            client_id: "start",
            role: "user",
            content: "Work",
            created_at: "2026-10-28T00:00:00.000Z"
          }
        })
        const first = {
          runId: run.runId,
          sessionId: session.sessionId,
          toolCallId: "first",
          toolName: "file_read",
          arguments: { path: "/tmp/first" },
          changesState: false
        }
        const second = { ...first, toolCallId: "second" }
        yield* tools.begin(first)
        yield* tools.pause(first, { reason: "approval", preview: "Read first" })
        yield* tools.begin(second)
        yield* tools.pause(second, { reason: "approval", preview: "Read second" })
        const input = {
          sessionId: session.sessionId,
          clientId: "reply",
          requestHash: "reply",
          assistantMessageId: "reply-answer",
          wake: true,
          approvalReply: { runId: run.runId, toolId: "first" },
          message: {
            message_id: "reply",
            client_id: "reply",
            role: "user" as const,
            content: "Keep it private",
            created_at: "2026-10-28T00:01:00.000Z"
          }
        }
        expect(yield* chat.receive(input)).toEqual({ _tag: "Queued", runId: run.runId })
        return { input, runId: run.runId }
      }).pipe(Effect.provide(layer()))
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatWriteStore
        const history = yield* ToolHistoryQueries
        expect(yield* chat.receive(saved.input)).toEqual({
          _tag: "Existing",
          runId: saved.runId,
          status: "queued"
        })
        expect(
          (yield* history.pendingApprovals(saved.input.sessionId)).map(
            (approval) => approval.tool_id
          )
        ).toEqual(["second"])
        expect(
          (yield* chat.drainPending(saved.runId)).map(
            (message) => userContent(message.content).text
          )
        ).toEqual(["Keep it private"])
        expect(yield* chat.drainPending(saved.runId)).toEqual([])
      }).pipe(Effect.provide(layer()))
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("routes a visible child's denial reason once to each recipient", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const chat = yield* ChatWriteStore
      const tools = yield* ToolExecutionStore
      const sql = yield* SqlClient.SqlClient
      const parent = yield* sessions.create({ name: "Parent reply" })
      const run = yield* chat.start({
        sessionId: parent.sessionId,
        clientId: "parent",
        requestHash: "parent",
        assistantMessageId: "answer",
        message: {
          message_id: "parent",
          client_id: "parent",
          role: "user",
          content: "Research",
          created_at: new Date().toISOString()
        }
      })
      const spawn = {
        runId: run.runId,
        sessionId: parent.sessionId,
        toolCallId: "spawn",
        toolName: "spawn_agent",
        changesState: true,
        arguments: { task: "Research", mode: "research" }
      }
      yield* tools.begin(spawn)
      const { child } = yield* chat.spawnAgent({
        parent: spawn,
        task: "Research",
        mode: "research"
      })
      const call = {
        runId: child.runId,
        sessionId: child.sessionId,
        toolCallId: "child-read",
        toolName: "file_read",
        changesState: false,
        arguments: { path: "/tmp/private" }
      }
      yield* tools.begin(call)
      yield* tools.pause(call, { reason: "approval", preview: "Read file" })
      const input = {
        sessionId: parent.sessionId,
        clientId: "reply",
        requestHash: "reply",
        assistantMessageId: "reply-answer",
        wake: true,
        approvalReply: { runId: child.runId, toolId: "child-read" },
        message: {
          message_id: "reply",
          client_id: "reply",
          role: "user" as const,
          content: "Keep that file private",
          created_at: new Date().toISOString()
        }
      }
      expect(yield* chat.receive(input)).toEqual({ _tag: "Queued", runId: run.runId })
      expect(yield* chat.receive(input)).toEqual({
        _tag: "Existing",
        runId: run.runId,
        status: "queued"
      })
      expect(
        yield* sql`SELECT status, result_feedback FROM tool_approvals WHERE run_id = ${child.runId} AND tool_call_id = 'child-read'`
      ).toEqual([{ status: "rejected", result_feedback: "Keep that file private" }])
      expect(
        (yield* chat.drainPending(run.runId))
          .filter((message) => message.client_id === "reply")
          .map((message) => userContent(message.content).text)
      ).toEqual(["Keep that file private"])
      expect(yield* chat.drainPending(run.runId)).toEqual([])
      expect(yield* chat.drainPending(child.runId)).toEqual([])
      expect(yield* tools.begin(call)).toMatchObject({
        _tag: "Recovered",
        outcome: {
          status: "completed",
          result: {
            content: "The user rejected this tool execution. Feedback: Keep that file private"
          }
        }
      })
    })
  )
})

it.each([true, false])(
  "issue 56 preserves accepted question identity in durable live events: %s",
  async (answer) => {
    await withTempDatabase(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        const chat = yield* ChatWriteStore
        const journal = yield* ChatEventStore
        const session = yield* sessions.create({ name: "Focus continuation" })
        const started = yield* chat.start({
          sessionId: session.sessionId,
          clientId: "answer",
          requestHash: "answer",
          assistantMessageId: "assistant",
          message: {
            message_id: "answer",
            client_id: "answer",
            role: "user",
            content: "Continue here",
            is_meta: answer,
            created_at: "2026-11-02T00:00:00Z",
            ...(answer ? { question_answer: { question_id: "exact-focus-question" } } : {})
          }
        })
        if (started._tag !== "Started") return yield* Effect.die("Expected admission")
        const page = yield* journal.readPage({
          sessionId: session.sessionId,
          afterSequence: 0,
          throughSequence: started.committed.records.at(-1)?.sequence ?? 0,
          limit: 100
        })
        const event = page.records.find((record) => record.event.type === "RUN_STARTED")?.event
        expect(event).toBeDefined()
        if (event?.type !== "RUN_STARTED") return yield* Effect.die("Expected start event")
        expect(event.question_answer).toEqual(
          answer ? { question_id: "exact-focus-question" } : undefined
        )
        const frames = decodeServerEventStreamBuffer(encodeServerEventFrame(event))
        expect(frames[0]?.data).toEqual(event)
        expect(
          started.activeMessages.find((message) => message.message_id === "answer")?.question_answer
        ).toEqual(answer ? { question_id: "exact-focus-question" } : undefined)
      })
    )
  }
)
