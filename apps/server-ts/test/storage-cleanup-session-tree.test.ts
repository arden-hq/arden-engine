import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { StorageSessionStore } from "../src/persistence/storage/session-store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const at = "2026-10-25T09:00:00.000Z"

const addChild = (
  sql: SqlClient.SqlClient,
  child: { readonly id: string; readonly parent: string; readonly type: "agent" | "chat" }
) =>
  child.type === "chat"
    ? sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
          session_type, parent_session_id)
        VALUES (${child.id}, ${child.id}, ${at}, ${at}, 'chat', ${child.parent})`
    : Effect.gen(function* () {
        const run = `${child.id}-spawner`
        yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at, ended_at, assistant_message_id)
          VALUES (${run}, ${child.parent}, 'completed', ${at}, ${at}, ${at}, ${`${run}-answer`})`
        yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
            session_type, parent_session_id, parent_run_id, parent_tool_call_id)
          VALUES (${child.id}, ${child.id}, ${at}, ${at}, 'agent', ${child.parent}, ${run}, 'spawn')`
      })

const addFork = (
  sql: SqlClient.SqlClient,
  fork: { readonly id: string; readonly source: string; readonly disposition: string }
) =>
  Effect.gen(function* () {
    yield* addChild(sql, { id: fork.id, parent: fork.source, type: "chat" })
    yield* sql`INSERT INTO session_fork_requests
      (request_id, source_session_id, request_json, child_session_id, state)
      VALUES (${`${fork.id}-request`}, ${fork.source},
        ${JSON.stringify({ disposition: fork.disposition })}, ${fork.id}, 'ready')`
  })

const candidateOf = (storage: StorageSessionStore["Service"], sessionId: string) =>
  Effect.map(storage.candidates(), (snapshot) =>
    snapshot.candidates.find((candidate) => candidate.sessionId === sessionId)
  )

const present = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ readonly session_id: string }>`SELECT session_id FROM sessions ORDER BY session_id`,
    (rows) => rows.map((row) => row.session_id)
  )

it("deletes a chat with its agents and Side chats at any depth", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const storage = yield* StorageSessionStore
      const chat = yield* (yield* SessionStore).create({ name: "Trip" })
      yield* addChild(sql, { id: "agent", parent: chat.sessionId, type: "agent" })
      yield* addChild(sql, { id: "agent-agent", parent: "agent", type: "agent" })
      yield* addFork(sql, { id: "side", source: chat.sessionId, disposition: "disposable" })
      const candidate = yield* candidateOf(storage, chat.sessionId)
      if (candidate === undefined) return yield* Effect.die("no candidate")
      yield* storage.deleteCandidate(candidate)
      return { candidate, left: yield* present(sql) }
    })
  )
  expect(outcome.candidate.protections).toEqual([])
  expect(outcome.candidate.deletesWith).toEqual({
    agents: 2,
    sideChats: 1,
    sessionIds: ["agent", "agent-agent", "side"]
  })
  expect(outcome.left).toEqual([])
})

it.each([
  { kept: "a retained fork", parent: "chat", disposition: "retained" },
  { kept: "an agent's retained fork", parent: "agent", disposition: "retained" }
])("keeps a chat with $kept protected", async (row) => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const storage = yield* StorageSessionStore
      const chat = yield* (yield* SessionStore).create({ name: "Trip" })
      yield* addChild(sql, { id: "agent", parent: chat.sessionId, type: "agent" })
      yield* addFork(sql, {
        id: "fork",
        source: row.parent === "chat" ? chat.sessionId : "agent",
        disposition: row.disposition
      })
      const candidate = yield* candidateOf(storage, chat.sessionId)
      if (candidate === undefined) return yield* Effect.die("no candidate")
      const refused = yield* storage.deleteCandidate(candidate).pipe(Effect.flip)
      return { candidate, refused, left: yield* present(sql), chatId: chat.sessionId }
    })
  )
  expect(outcome.candidate.protections).toEqual(["linked_session"])
  expect(outcome.refused.reason).toBe("conflict")
  expect(outcome.left).toEqual(["agent", outcome.chatId, "fork"].sort())
})

it("refuses a chat while a Side chat of an agent has an active run", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const storage = yield* StorageSessionStore
      const chat = yield* (yield* SessionStore).create({ name: "Trip" })
      yield* addChild(sql, { id: "agent", parent: chat.sessionId, type: "agent" })
      yield* addFork(sql, { id: "side", source: "agent", disposition: "disposable" })
      const idle = yield* candidateOf(storage, chat.sessionId)
      yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at, assistant_message_id)
        VALUES ('side-run', 'side', 'running', ${at}, ${at}, 'side-answer')`
      const busy = yield* candidateOf(storage, chat.sessionId)
      if (idle === undefined) return yield* Effect.die("no candidate")
      const refused = yield* storage.deleteCandidate(idle).pipe(Effect.flip)
      return { busy, refused, left: yield* present(sql), chatId: chat.sessionId }
    })
  )
  expect(outcome.busy?.protections).toEqual(["active_work"])
  expect(outcome.refused.message).toBe("This chat changed. Preview the cleanup again.")
  expect(outcome.left).toEqual(["agent", outcome.chatId, "side"].sort())
})

it("refuses a preview taken before an agent joined the chat", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const storage = yield* StorageSessionStore
      const chat = yield* (yield* SessionStore).create({ name: "Trip" })
      yield* addChild(sql, { id: "agent", parent: chat.sessionId, type: "agent" })
      const previewed = yield* candidateOf(storage, chat.sessionId)
      if (previewed === undefined) return yield* Effect.die("no candidate")
      yield* addChild(sql, { id: "late-agent", parent: "agent", type: "agent" })
      const refused = yield* storage.deleteCandidate(previewed).pipe(Effect.flip)
      return { previewed, refused, left: yield* present(sql), chatId: chat.sessionId }
    })
  )
  expect(outcome.previewed.deletesWith).toEqual({ agents: 1, sideChats: 0, sessionIds: ["agent"] })
  expect(outcome.refused.message).toBe("This chat changed. Preview the cleanup again.")
  expect(outcome.left).toEqual(["agent", outcome.chatId, "late-agent"].sort())
})

it("refuses a chat an unfinished Task names, and a Task without a home keeps no other chat", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const storage = yield* StorageSessionStore
      const sessions = yield* SessionStore
      const named = yield* sessions.create({ name: "Named" })
      const other = yield* sessions.create({ name: "Other" })
      yield* sql`INSERT INTO space_tasks (item_id, stable_key, text, status, owner, created_at, updated_at)
        VALUES ('task', 'task', 'Book the trip', 'deferred', 'worker', ${at}, ${at})`
      yield* sql`INSERT INTO space_task_sources (item_id, source_key, source, created_at)
        VALUES ('task', 'chat', ${JSON.stringify({ kind: "chat", session_id: named.sessionId })}, ${at})`
      const namedCandidate = yield* candidateOf(storage, named.sessionId)
      const otherCandidate = yield* candidateOf(storage, other.sessionId)
      if (namedCandidate === undefined || otherCandidate === undefined) {
        return yield* Effect.die("no candidate")
      }
      const refused = yield* storage.deleteCandidate(namedCandidate).pipe(Effect.flip)
      yield* storage.deleteCandidate(otherCandidate)
      return {
        protections: [namedCandidate.protections, otherCandidate.protections],
        refused: refused.reason,
        left: yield* present(sql),
        namedId: named.sessionId
      }
    })
  )
  expect(outcome).toEqual({
    protections: [["active_work"], []],
    refused: "conflict",
    left: [outcome.namedId],
    namedId: outcome.namedId
  })
})
