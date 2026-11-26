import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { makeSessionTriage, makeSessionTriageAction } from "../src/assist/session-triage.js"
import { appendMessagesInTransaction } from "../src/persistence/sqlite/chat-transcript.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { spaceConversationContextSnapshot } from "../src/context/space.js"
import { partialService, serverRunContext } from "./kit.js"
import { makeOnboardingFinishTool } from "../src/tools/onboarding.js"

import { SpaceStore } from "../src/persistence/spaces/store.js"
import { AT, mainSpace, spaceOf } from "./main-space-kit.js"

it("triage never proposes a new Space under a name a Space already has", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const queries = yield* SessionQueries
      const spaces = yield* SpaceStore
      const sql = yield* SqlClient.SqlClient
      const chat = yield* sessions.create({ name: "Notes" })
      yield* appendMessagesInTransaction(
        sql,
        chat.sessionId,
        [
          { message_id: "ask", role: ROLE.user, content: "Hi", created_at: AT },
          { message_id: "answer", role: ROLE.assistant, content: "Hello", created_at: AT }
        ],
        AT,
        "post",
        "ask"
      )
      const decision = yield* makeSessionTriage({
        completion: {
          runTool: <S extends Schema.ConstraintDecoder<unknown>>(request: {
            readonly result: { readonly schema: S }
          }) =>
            Schema.decodeUnknownEffect(request.result.schema)({
              decision: "create",
              target: null,
              new_title: "main",
              confident: true,
              rationale: "General"
            }).pipe(Effect.orDie)
        },
        sessions: queries,
        spaces,
        wiki: { ensureSpacePage: () => Effect.die("no Memory in this test") },
        store: sessions
      })(chat.sessionId)
      expect(decision).toMatchObject({ decision: "none" })
      expect((yield* spaces.list()).map((space) => space.name)).toEqual(["Main"])
    })
  )
})

it("a Space name already in use is a conflict, and triage then leaves the other Space alone", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const queries = yield* SessionQueries
      const spaces = yield* SpaceStore
      const sql = yield* SqlClient.SqlClient
      const chat = yield* sessions.create({ name: "Notes" })
      yield* appendMessagesInTransaction(
        sql,
        chat.sessionId,
        [
          { message_id: "ask", role: ROLE.user, content: "Hi", created_at: AT },
          { message_id: "answer", role: ROLE.assistant, content: "Hello", created_at: AT }
        ],
        AT,
        "post",
        "ask"
      )
      const dependencies = {
        completion: {
          runTool: <S extends Schema.ConstraintDecoder<unknown>>(request: {
            readonly result: { readonly schema: S }
          }) =>
            Schema.decodeUnknownEffect(request.result.schema)({
              decision: "create",
              target: null,
              new_title: "Projects",
              confident: true,
              rationale: "Work"
            }).pipe(Effect.orDie)
        },
        sessions: queries,
        spaces,
        wiki: { ensureSpacePage: () => Effect.die("no Memory in this test") },
        store: sessions
      }
      expect(yield* makeSessionTriage(dependencies)(chat.sessionId)).toMatchObject({
        decision: "create"
      })
      const projects = yield* spaces.create({
        name: "Projects",
        instructions: { kind: "unwritten" }
      })
      expect(
        yield* spaces
          .create({ name: "projects", instructions: { kind: "unwritten" } })
          .pipe(Effect.flip)
      ).toMatchObject({
        reason: "conflict"
      })
      const accepted = yield* makeSessionTriageAction(dependencies)(chat.sessionId, "accept").pipe(
        Effect.flip
      )
      expect(accepted).toMatchObject({ reason: "stale" })
      expect((yield* spaces.get(projects.space_id))?.archived_at).toBeNull()
      expect(yield* spaceOf(chat.sessionId)).toBe((yield* mainSpace).space_id)
    })
  )
})

it("a Task filed by chat id for a chat in Main lands on Main with the chat as its home", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const main = yield* mainSpace
      const chat = yield* (yield* SessionStore).create({ name: "Loose" })
      const task = yield* (yield* WorkStore).create(
        { kind: "chat", sessionId: chat.sessionId },
        { key: "reply", text: "Reply to Ana", runs_in: "chat" }
      )
      expect(task).toMatchObject({ space_id: main.space_id, home_session_id: chat.sessionId })
    })
  )
})

it("a Task filed by the id of an archived chat is refused", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const chat = yield* sessions.create({ name: "Old" })
      yield* sessions.archive(chat.sessionId)
      const refused = yield* (yield* WorkStore)
        .create({ kind: "chat", sessionId: chat.sessionId }, { key: "reply", text: "Reply" })
        .pipe(Effect.flip)
      expect(refused).toMatchObject({ reason: "not_found" })
    })
  )
})

it("a branch of a chat in no Space cannot share its resources", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sessions = yield* SessionStore
      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
          session_type, origin_automation_id, context_from_seq)
        VALUES ('automation-chat', 'automation-chat', ${AT}, ${AT}, 'channel', 'daily', 0)`
      const refused = yield* sessions
        .branch("automation-chat", { disposition: "retained", shareResources: true })
        .pipe(Effect.flip)
      expect(refused).toMatchObject({ operation: "branch", reason: "invalid" })
      expect(yield* sessions.branch("automation-chat", { disposition: "retained" })).toMatchObject({
        spaceId: (yield* mainSpace).space_id
      })
    })
  )
})

it("a Task filed by the id of an agent session is refused", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const chat = yield* (yield* SessionStore).create({ name: "Parent" })
      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
          session_type, space_id, parent_session_id, parent_run_id, parent_tool_call_id)
        VALUES ('agent', 'agent', ${AT}, ${AT}, 'agent', ${chat.spaceId ?? null},
          ${chat.sessionId}, 'run', 'call')`
      const refused = yield* (yield* WorkStore)
        .create({ kind: "chat", sessionId: "agent" }, { key: "reply", text: "Reply" })
        .pipe(Effect.flip)
      expect(refused).toMatchObject({ reason: "not_found" })
    })
  )
})

it("the Space detail lists every chat; only the model context keeps the 50 newest", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const main = yield* mainSpace
      for (let index = 0; index < 55; index += 1) yield* sessions.create({ name: `Chat ${index}` })
      const spaces = yield* SpaceStore
      const detail = yield* spaces.detail(main.space_id)
      expect(detail?.sessions).toHaveLength(55)
      const context = yield* spaceConversationContextSnapshot({
        spaceId: main.space_id,
        sessionId: "none",
        spaces,
        summaries: { chats: () => Effect.succeed(new Map()) },
        memory: undefined,
        work: yield* WorkStore
      })
      expect(context?.view.chats.length).toBeGreaterThanOrEqual(49)
      expect(context?.view.chats.length).toBeLessThanOrEqual(50)
    })
  )
})

it("continuing an Automation copy moves its agents too, and waits while one of them runs", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sessions = yield* SessionStore
      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
          session_type, origin_automation_id, context_from_seq)
        VALUES ('daily-chat', 'daily-chat', ${AT}, ${AT}, 'channel', 'daily', 0)`
      yield* sql`INSERT INTO scheduled_tasks (task_id, automation_ref, name, prompt, triggers,
          created_at, purpose, thread_id, context_mode)
        VALUES ('daily', 'daily', 'Daily', 'Check', '[]', ${AT}, 'user_automation',
          'daily-chat', 'continue')`
      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
          session_type, origin_automation_id, parent_session_id, metadata, context_from_seq)
        VALUES ('copy', 'copy', ${AT}, ${AT}, 'chat', 'daily', 'daily-chat',
          '{"fork_origin":{"sourceSessionId":"daily-chat"}}', 0)`
      yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
          ended_at, assistant_message_id)
        VALUES ('spawner', 'copy', 'completed', ${AT}, ${AT}, ${AT}, 'answer')`
      yield* sql`UPDATE chat_runs SET metadata_json = '{"turn_id":"turn"}' WHERE run_id = 'spawner'`
      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
          session_type, origin_automation_id, parent_session_id, parent_run_id,
          parent_tool_call_id, context_from_seq)
        VALUES ('agent', 'agent', ${AT}, ${AT}, 'agent', 'daily', 'copy', 'spawner', 'call', 0)`
      yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
          assistant_message_id)
        VALUES ('agent-run', 'agent', 'running', ${AT}, ${AT}, 'agent-answer')`
      expect(yield* sessions.continueRun("copy").pipe(Effect.flip)).toMatchObject({
        reason: "conflict"
      })
      yield* sql`UPDATE chat_runs SET status = 'completed', ended_at = updated_at
        WHERE run_id = 'agent-run'`
      expect(yield* sessions.continueRun("copy")).toBe(true)
      const main = (yield* mainSpace).space_id
      expect([yield* spaceOf("copy"), yield* spaceOf("agent")]).toEqual([main, main])
    })
  )
})

it("a Task filed by the id of a side chat is refused", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const chat = yield* sessions.create({ name: "Main chat" })
      const side = yield* sessions.branch(chat.sessionId, { disposition: "disposable" })
      const refused = yield* (yield* WorkStore)
        .create({ kind: "chat", sessionId: side?.sessionId ?? "" }, { key: "reply", text: "Reply" })
        .pipe(Effect.flip)
      expect(refused).toMatchObject({ reason: "invalid", message: "This chat cannot hold a Task." })
    })
  )
})

it("a second onboarding_finish that changes nothing reports no change", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const queries = yield* SessionQueries
      const chat = yield* sessions.create({ origin: "onboarding" })
      const marked = yield* queries.loadHeaderSnapshot(chat.sessionId)
      if (marked === null) return yield* Effect.die("no chat")
      yield* sessions.finishOnboarding(chat.sessionId)
      const tool = makeOnboardingFinishTool({
        sessions: partialService<SessionQueries["Service"]>("SessionQueries", {
          loadHeaderSnapshot: () => Effect.succeed(marked)
        }),
        store: sessions
      })
      const result = yield* Effect.promise(() =>
        Promise.resolve(
          tool.execute(
            {},
            {
              toolCallId: "call",
              signal: new AbortController().signal,
              run: serverRunContext({ sessionId: chat.sessionId, runId: "run" }),
              messages: []
            }
          )
        )
      )
      expect(result).toMatchObject({
        content: "Getting started already ended.",
        host: { mutation_receipt: { outcome: "no_op" } }
      })
    })
  )
})
