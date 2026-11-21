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
import { serverRunContext } from "./kit.js"
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
      const work = yield* spaces.create({ name: "Work" })
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
      const work = yield* spaces.create({ name: "Work" })

      const loose = yield* sessions.create({ name: "Loose" })
      const capture = yield* sessions.create({ origin: "capture" })
      expect([loose.spaceId, capture.spaceId]).toEqual([main.space_id, main.space_id])

      const filed = yield* sessions.create({ name: "Filed", spaceId: work.space_id })
      expect(yield* sessions.moveToSpace(filed.sessionId, undefined)).toBe(true)
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

      const listed = yield* sessions.list({ inbox: true, scope: "primary" })
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
      const work = yield* spaces.create({ name: "Work" })
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
      const work = yield* spaces.create({ name: "Work" })
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
