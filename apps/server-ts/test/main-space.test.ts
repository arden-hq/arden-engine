import { ROLE } from "@arden-hq/std/message-vocabulary"
import { ChatStop } from "../src/chat/chat-stop.js"
import { ChatMessage } from "../src/chat/message.js"
import { TerminalSessions } from "../src/terminals/service.js"
import { ScriptRunner } from "../src/workflows/script-runner.js"
import { errorMessage } from "@arden-hq/std/errors"
import { Effect, Layer, Schema } from "effect"
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
import { RunQueries } from "../src/persistence/runs/queries.js"
import { runInspectTool } from "../src/tools/run-inspection.js"
import { sessionTools } from "../src/tools/sessions.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { spaceArchiveTools } from "../src/tools/space-archive.js"
import { spaceConversationContextSnapshot } from "../src/context/space.js"
import { renderCaptureSpaces } from "../src/context/special-chat.js"
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

it("the phone's loose list shows Main's chats but not Main's own conversation", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const main = yield* mainSpace
      const bound = yield* sessions.ensureSpaceConversation(main.space_id)
      const chat = yield* sessions.create({ name: "Loose" })
      const listed = (yield* sessions.list({ inbox: true, scope: "primary" })).map(
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
          AND json_extract(record.data_json, '$.id') = ${chat.sessionId}`
      const before = (yield* told)[0]?.count ?? 0
      expect(yield* sessions.finishOnboarding(chat.sessionId)).toBe(true)
      expect((yield* told)[0]?.count).toBe(before + 1)
    })
  )
})

it("run_inspect from a Main chat reaches a chat on another Space", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const spaces = yield* SpaceStore
      const queries = yield* SessionQueries
      const work = yield* spaces.create({ name: "Work" })
      const there = yield* sessions.create({ spaceId: work.space_id })
      const here = yield* sessions.create({})
      const ref = (yield* queries.loadHistoryHeader(there.sessionId))?.publicRef ?? ""
      const tool = runInspectTool({ runs: yield* RunQueries, sessions: queries })
      const refusal = yield* Effect.promise(async () => {
        try {
          await tool.execute(
            { session_ref: ref },
            {
              toolCallId: "call",
              signal: new AbortController().signal,
              run: serverRunContext({
                sessionId: here.sessionId,
                runId: "run",
                authority: person(here.sessionId)
              }),
              messages: []
            }
          )
          return "ran"
        } catch (error) {
          return errorMessage(error)
        }
      })
      expect(refusal).toBe("No retained run for this chat")
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
      const projects = yield* spaces.create({ name: "Projects" })
      expect(yield* spaces.create({ name: "projects" }).pipe(Effect.flip)).toMatchObject({
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

it("Space context reads summaries only for the chats it lists", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const spaces = yield* SpaceStore
      const main = yield* mainSpace
      for (let index = 0; index < 55; index += 1) yield* sessions.create({ name: `Chat ${index}` })
      const asked: Array<number> = []
      yield* spaceConversationContextSnapshot({
        spaceId: main.space_id,
        sessionId: "none",
        spaces,
        summaries: {
          chats: (ids) => {
            asked.push(ids.length)
            return Effect.succeed(new Map())
          }
        },
        memory: undefined,
        work: yield* WorkStore
      })
      expect(asked).toEqual([50])
    })
  )
})

it("the capture list leaves Main out and says whether this chat is in Main", () => {
  const spaces = [
    { space_id: "main", kind: "main" as const, name: "Main space", instructions: null },
    { space_id: "taxes", kind: "ordinary" as const, name: "Main", instructions: "Tax papers" }
  ]
  const inMain = renderCaptureSpaces({ spaces, chatInMain: true })
  expect(inMain).toContain("This chat is in the Main Space.")
  expect(inMain).toContain("- Main (space_id taxes): Tax papers")
  expect(inMain).not.toContain("space_id main")
  expect(renderCaptureSpaces({ spaces, chatInMain: false })).toContain(
    "This chat is already on a Space."
  )
})

it("session_read from a Main chat names another Space's chat, not another Main chat", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const spaces = yield* SpaceStore
      const queries = yield* SessionQueries
      const work = yield* spaces.create({ name: "Work" })
      const here = yield* sessions.create({ name: "Here" })
      const sibling = yield* sessions.create({ name: "Sibling" })
      const there = yield* sessions.create({ name: "There", spaceId: work.space_id })
      const sql = yield* SqlClient.SqlClient
      for (const chat of [sibling, there])
        yield* appendMessagesInTransaction(
          sql,
          chat.sessionId,
          [{ message_id: "hello", role: ROLE.user, content: "Hello", created_at: AT }],
          AT,
          "post",
          "hello"
        )
      const read = (yield* sessionTools).find((tool) => tool.definition.name === "session_read")
      if (read === undefined) return yield* Effect.die("no session_read")
      const readRef = (sessionId: string) =>
        Effect.gen(function* () {
          const ref = (yield* queries.loadHistoryHeader(sessionId))?.publicRef ?? ""
          const result = yield* Effect.promise(() =>
            Promise.resolve(
              read.execute(
                { session_ref: ref, limit: 10, content_chars: 1000 },
                {
                  toolCallId: "call",
                  signal: new AbortController().signal,
                  run: serverRunContext({
                    sessionId: here.sessionId,
                    runId: "run",
                    authority: person(here.sessionId)
                  }),
                  messages: []
                }
              )
            )
          )
          return JSON.stringify(result)
        })
      expect(yield* readRef(sibling.sessionId)).not.toContain("not this chat's")
      expect(yield* readRef(there.sessionId)).toContain("not this chat's")
    })
  )
})

it("space_archive refuses Main before it asks anyone", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const [archive] = yield* spaceArchiveTools
      const main = yield* mainSpace
      const here = yield* (yield* SessionStore).create({})
      const started = yield* (yield* ChatWriteStore).start({
        sessionId: here.sessionId,
        clientId: "ask",
        requestHash: "ask",
        assistantMessageId: "answer",
        message: {
          message_id: "ask",
          client_id: "ask",
          role: ROLE.user,
          content: "Archive Main",
          created_at: AT
        }
      })
      if (started._tag !== "Started") return yield* Effect.die("no run")
      if (archive?.definition.approvalPrompt === undefined) return yield* Effect.die("no prompt")
      const prompt = archive.definition.approvalPrompt
      const refused = yield* Effect.promise(async () => {
        try {
          await prompt(
            { space_id: main.space_id },
            {
              toolCallId: "call",
              signal: new AbortController().signal,
              run: serverRunContext({ sessionId: here.sessionId, runId: started.runId }),
              messages: []
            }
          )
          return "asked"
        } catch (error) {
          return errorMessage(error)
        }
      })
      expect(refused).toBe("The Main Space cannot be archived.")
    })
  )
})

it("ending Main with stop refuses before it stops any of Main's chats", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const main = yield* mainSpace
      const refused = yield* Effect.gen(function* () {
        const stop = yield* ChatStop
        return yield* stop.endSpace({ spaceId: main.space_id, stop: true }).pipe(Effect.flip)
      }).pipe(
        Effect.provide(
          ChatStop.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(
                  ChatMessage,
                  partialService<ChatMessage["Service"]>("ChatMessage", {})
                ),
                Layer.succeed(RunQueries, partialService<RunQueries["Service"]>("RunQueries", {})),
                Layer.succeed(
                  TerminalSessions,
                  partialService<TerminalSessions["Service"]>("TerminalSessions", {})
                ),
                Layer.succeed(
                  ScriptRunner,
                  partialService<ScriptRunner["Service"]>("ScriptRunner", {})
                ),
                Layer.succeed(SessionStore, yield* SessionStore),
                Layer.succeed(SessionQueries, yield* SessionQueries),
                Layer.succeed(SpaceStore, yield* SpaceStore),
                Layer.succeed(WorkStore, yield* WorkStore)
              )
            )
          )
        )
      )
      expect(refused).toMatchObject({
        reason: "conflict",
        message: "The Main Space cannot be archived."
      })
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
