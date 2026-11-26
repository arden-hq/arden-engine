import { ROLE } from "@arden-hq/std/message-vocabulary"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { seesEveryChat } from "../src/tools/session-browse-scope.js"
import { makeSessionTriage, makeSessionTriageAction } from "../src/assist/session-triage.js"
import { appendMessagesInTransaction } from "../src/persistence/sqlite/chat-transcript.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { listedSessionToWire } from "../src/http/wire/sessions.js"
import { looseChats } from "../src/mobile/spaces.js"
import { makeCaptureRouter } from "../src/routing/capture.js"
import { WorkStore } from "../src/persistence/work/store.js"
import { SummaryStore } from "../src/persistence/summaries/store.js"
import { journalRecordsSql } from "@arden-hq/journal/effect"
import { SESSION_LIFECYCLE_STREAM_ID } from "../src/persistence/sessions/events.js"
import { spaceConversationContextSnapshot } from "../src/context/space.js"
import { partialService, serverRunContext } from "./kit.js"
import { deriveAuthority, type RunAuthority } from "../src/execution/authority.js"
import { decide } from "../src/execution/decide.js"
import { defaultImpact } from "../src/execution/impact.js"
import type { RunPolicy } from "../src/execution/policy.js"
import { toolFacts } from "../src/tools/approval-decision.js"
import { makeOnboardingFinishTool } from "../src/tools/onboarding.js"
import { sessionSearchTools } from "../src/tools/session-search.js"
import { StorageSessionStore } from "../src/persistence/storage/session-store.js"

const AT = "2026-11-20T00:00:00.000Z"

const mainSpace = Effect.gen(function* () {
  const spaces = yield* SpaceStore
  const listed = yield* spaces.list()
  const main = listed.find((space) => space.kind === "main")
  if (main === undefined) return yield* Effect.die("no Main Space")
  return main
})

const spaceOf = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly space_id: string | null }>`
      SELECT space_id FROM sessions WHERE session_id = ${sessionId}`
    return rows[0]?.space_id
  })

it("a new database has one Main Space; it lists first and cannot be archived", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const spaces = yield* SpaceStore
      const work = yield* spaces.create({ name: "Work", instructions: { kind: "unwritten" } })
      const listed = yield* spaces.list()
      expect(listed.map((space) => [space.name, space.kind])).toEqual([
        ["Main", "main"],
        ["Work", "ordinary"]
      ])
      const main = yield* mainSpace
      const overview = yield* spaces.overview()
      expect(overview.spaces.map((space) => [space.title, space.kind])).toEqual([
        ["Main", "main"],
        ["Work", "ordinary"]
      ])
      const refused = yield* spaces.archive(main.space_id).pipe(Effect.flip)
      expect(refused).toMatchObject({
        reason: "conflict",
        message: "The Main Space cannot be archived."
      })
      expect(yield* spaces.archive(work.space_id)).toMatchObject({ status: "archived" })
      expect((yield* spaces.list()).map((space) => space.name)).toEqual(["Main"])
    })
  )
})

it("a chat made, moved or branched with no Space lands in Main and sees every Space's chats", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const queries = yield* SessionQueries
      const spaces = yield* SpaceStore
      const sql = yield* SqlClient.SqlClient
      const main = yield* mainSpace
      const work = yield* spaces.create({ name: "Work", instructions: { kind: "unwritten" } })

      const loose = yield* sessions.create({ name: "Loose" })
      const capture = yield* sessions.create({ origin: "capture" })
      expect([loose.spaceId, capture.spaceId]).toEqual([main.space_id, main.space_id])

      const filed = yield* sessions.create({ name: "Filed", spaceId: work.space_id })
      expect(yield* sessions.moveToSpace(filed.sessionId, undefined)).toBe(main.space_id)
      expect(yield* spaceOf(filed.sessionId)).toBe(main.space_id)

      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
          session_type, origin_automation_id, context_from_seq)
        VALUES ('automation-chat', 'automation-chat', ${AT}, ${AT}, 'channel', 'daily', 0)`
      const kept = yield* sessions.branch("automation-chat", { disposition: "retained" })
      const side = yield* sessions.branch("automation-chat", { disposition: "disposable" })
      expect([
        yield* spaceOf(kept?.sessionId ?? ""),
        yield* spaceOf(side?.sessionId ?? "")
      ]).toEqual([main.space_id, main.space_id])
      expect([kept?.spaceId, side?.spaceId]).toEqual([main.space_id, main.space_id])

      const inMain = yield* queries.loadHistoryHeader(loose.sessionId)
      const inWork = yield* queries.loadHistoryHeader(
        (yield* sessions.create({ spaceId: work.space_id })).sessionId
      )
      expect([inMain?.spaceKind, inWork?.spaceKind]).toEqual(["main", "ordinary"])
      expect(
        [inMain, inWork].map(
          (header) => header !== null && seesEveryChat(header, { authority: person("chat") })
        )
      ).toEqual([true, false])
      expect(inMain !== null && seesEveryChat(inMain, { authority: taskWorker("chat") })).toBe(
        false
      )

      const listed = yield* sessions.list({
        spaceId: (yield* mainSpace).space_id,
        scope: "primary"
      })
      expect(listed.map((entry) => entry.sessionId).toSorted()).toEqual(
        [loose.sessionId, capture.sessionId, filed.sessionId, kept?.sessionId].toSorted()
      )
    })
  )
})

it("Getting started ends once, and only in the chat that has it", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const queries = yield* SessionQueries
      const onboarding = yield* sessions.create({ origin: "onboarding" })
      const plain = yield* sessions.create({})
      expect(yield* sessions.finishOnboarding(onboarding.sessionId)).toBe(true)
      expect(yield* sessions.finishOnboarding(onboarding.sessionId)).toBe(false)
      expect(yield* sessions.finishOnboarding(plain.sessionId)).toBe(false)
      const header = yield* queries.loadHeaderSnapshot(onboarding.sessionId)
      expect(header?.metadata).toEqual({})
    })
  )
})

it("triage files a chat from Main into another Space and undo brings it back to Main", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const queries = yield* SessionQueries
      const spaces = yield* SpaceStore
      const sql = yield* SqlClient.SqlClient
      const main = yield* mainSpace
      const work = yield* spaces.create({ name: "Work", instructions: { kind: "unwritten" } })
      const chat = yield* sessions.create({ name: "Invoices" })
      yield* appendMessagesInTransaction(
        sql,
        chat.sessionId,
        [
          { message_id: "ask", role: ROLE.user, content: "Send the invoice", created_at: AT },
          { message_id: "answer", role: ROLE.assistant, content: "Sent it.", created_at: AT }
        ],
        AT,
        "post",
        "ask"
      )
      const offered: Array<unknown> = []
      const dependencies = {
        completion: {
          runTool: <S extends Schema.ConstraintDecoder<unknown>>(request: {
            readonly user: string
            readonly result: { readonly schema: S }
          }) => {
            offered.push(JSON.parse(request.user).spaces)
            return Schema.decodeUnknownEffect(request.result.schema)({
              decision: "move",
              target: { space_id: work.space_id, title: "Work" },
              new_title: null,
              confident: true,
              rationale: "About work"
            }).pipe(Effect.orDie)
          }
        },
        sessions: queries,
        spaces,
        wiki: { ensureSpacePage: () => Effect.die("no Memory in this test") },
        store: sessions
      }
      yield* makeSessionTriage(dependencies)(chat.sessionId)
      expect(offered).toEqual([[{ space_id: work.space_id, title: "Work" }]])
      expect(yield* spaceOf(chat.sessionId)).toBe(work.space_id)
      yield* makeSessionTriageAction(dependencies)(chat.sessionId, "undo")
      expect(yield* spaceOf(chat.sessionId)).toBe(main.space_id)
    })
  )
})

const person = (sessionId: string) =>
  deriveAuthority({
    sessionId,
    context: { origin: { kind: "chat", session_id: sessionId, turn_id: "t1" }, task: null },
    policy: runPolicy,
    originOwner: null,
    chatOwner: null
  })

const taskWorker = (sessionId: string) =>
  deriveAuthority({
    sessionId,
    context: {
      origin: { kind: "task", item_id: "task-1", occurrence_id: "o1" },
      task: { item_id: "task-1", generation: 1 }
    },
    policy: runPolicy,
    originOwner: null,
    chatOwner: null
  })

const runPolicy = {
  budget_id: "budget",
  budget_generation: 0,
  execution: { mode: "inline", observe: false },
  capabilities: ["all"],
  auto_approve: false,
  google_accounts: null,
  space: null
} satisfies RunPolicy

it("a chat in Main searches every Space by default, but only for runs that may browse them", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const spaces = yield* SpaceStore
      const sql = yield* SqlClient.SqlClient
      const work = yield* spaces.create({ name: "Work", instructions: { kind: "unwritten" } })
      const there = yield* sessions.create({ name: "Zebra plans", spaceId: work.space_id })
      yield* appendMessagesInTransaction(
        sql,
        there.sessionId,
        [{ message_id: "zebra", role: ROLE.user, content: "zebra crossing", created_at: AT }],
        AT,
        "post",
        "zebra"
      )
      const here = yield* sessions.create({ name: "Loose" })
      const [search] = yield* sessionSearchTools
      if (search === undefined) return yield* Effect.die("no search tool")
      const searchAs = (authority: RunAuthority) =>
        Effect.promise(() =>
          Promise.resolve(
            search.execute(
              { query: "zebra", limit: 5, offset: 0 },
              {
                toolCallId: "call",
                signal: new AbortController().signal,
                run: serverRunContext({ sessionId: here.sessionId, runId: "run", authority }),
                messages: []
              }
            )
          )
        )
      expect(yield* searchAs(person(here.sessionId))).toMatchObject({ preview: "1 hit" })
      expect(yield* searchAs(taskWorker(here.sessionId))).toMatchObject({ preview: "0 hits" })
    })
  )
})

it("triage and storage cleanup leave Main's own conversation alone; other Main chats can go", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const queries = yield* SessionQueries
      const storage = yield* StorageSessionStore
      const main = yield* mainSpace
      const bound = yield* sessions.ensureSpaceConversation(main.space_id)
      const other = yield* sessions.create({ name: "Other" })
      expect([
        (yield* queries.loadHistoryHeader(bound))?.spaceConversation,
        (yield* queries.loadHistoryHeader(other.sessionId))?.spaceConversation
      ]).toEqual([true, false])
      const protections = new Map(
        (yield* storage.candidates()).candidates.map((candidate) => [
          candidate.sessionId,
          candidate.protections
        ])
      )
      expect(protections.get(bound)).toContain("space_owned")
      expect(protections.get(other.sessionId)).not.toContain("space_owned")
      const triage = makeSessionTriage({
        completion: { runTool: () => Effect.die("triage must not run") },
        sessions: queries,
        spaces: yield* SpaceStore,
        wiki: { ensureSpacePage: () => Effect.die("no Memory in this test") },
        store: sessions
      })
      const sql = yield* SqlClient.SqlClient
      yield* appendMessagesInTransaction(
        sql,
        bound,
        [
          { message_id: "ask", role: ROLE.user, content: "Hi", created_at: AT },
          { message_id: "answer", role: ROLE.assistant, content: "Hello", created_at: AT }
        ],
        AT,
        "post",
        "ask"
      )
      expect(yield* triage(bound)).toMatchObject({ decision: "none" })
    })
  )
})

it("onboarding_finish runs in a Read only chat", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const tool = makeOnboardingFinishTool({
        sessions: yield* SessionQueries,
        store: yield* SessionStore
      })
      const facts = toolFacts(tool.definition)
      const decision = decide(
        person("chat"),
        { state: "active", mode: "read_only", rule: undefined },
        {
          tool: facts,
          impact: defaultImpact(facts),
          available: true,
          unattended_scope: false,
          floor: undefined,
          target: undefined,
          requirement: false,
          user_only: false,
          reads_only: false,
          approved: false
        }
      )
      expect(decision.kind).toBe("allow")
    })
  )
})

it("the phone's loose list shows Main's chats but not Main's own conversation", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const main = yield* mainSpace
      const bound = yield* sessions.ensureSpaceConversation(main.space_id)
      const chat = yield* sessions.create({ name: "Loose" })
      const listed = (yield* sessions.list({ spaceId: main.space_id, scope: "primary" })).map(
        listedSessionToWire
      )
      expect(looseChats(listed).map((row) => row.session_id)).toEqual([chat.sessionId])
      expect(listed.map((row) => row.session_id)).toContain(bound)
    })
  )
})

it("an unmatched capture is kept in its own chat when Main is the only Space", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const route = makeCaptureRouter({
        spaces: yield* SpaceStore,
        work: yield* WorkStore,
        sessions: yield* SessionStore,
        summaries: yield* SummaryStore,
        decisions: { decide: () => Effect.die("nothing to choose between") }
      })
      expect(yield* route({ image: { mediaType: "image/png", data: "AAAA" }, note: "" })).toEqual({
        kind: "keep"
      })
    })
  )
})

it("ending Getting started tells clients the chat changed", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const sql = yield* SqlClient.SqlClient
      const chat = yield* sessions.create({ origin: "onboarding" })
      const told = sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM ${journalRecordsSql(sql)} AS record
        WHERE record.stream_id = ${SESSION_LIFECYCLE_STREAM_ID}
          AND record.event_type = 'entity_changed'
          AND json_extract(record.data_json, '$.kind') = 'session'
          AND json_extract(record.data_json, '$.target.id') = ${chat.sessionId}`
      const before = (yield* told)[0]?.count ?? 0
      expect(yield* sessions.finishOnboarding(chat.sessionId)).toBe(true)
      expect((yield* told)[0]?.count).toBe(before + 1)
    })
  )
})

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
