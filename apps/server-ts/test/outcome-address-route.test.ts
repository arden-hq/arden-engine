import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { TestClock } from "effect/testing"
import { expect, it } from "vitest"
import type { EndedAutomationRun } from "../src/persistence/sqlite/automation-run-outcome.js"
import { reconcileEndings, recordEnding } from "../src/persistence/sqlite/run-ending.js"
import { recordTell } from "../src/persistence/sqlite/run-tell.js"
import { TELL_LIMIT } from "../src/persistence/work/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const T = "2026-11-20T08:00:00.000Z"
const ENDED = "2026-11-20T08:05:00.000Z"

const chat = (sessionId: string) => ({ kind: "chat", session_id: sessionId, turn_id: "turn-1" })
const automation = (id: string) => ({
  kind: "automation",
  automation_id: id,
  occurrence_id: "occ-1"
})
const context = (origin: unknown, task: unknown = null) => ({ run_context: { origin, task } })

const sessions: ReadonlyArray<string> = [
  `INSERT INTO spaces (space_id, name, name_key, created_at, updated_at)
     VALUES ('sp', 'Space', 'space', '${T}', '${T}')`,
  ...[
    ["owner-chat", "chat", "NULL"],
    ["other-chat", "chat", "NULL"],
    ["thread-a", "chat", "NULL"],
    ["thread-b", "chat", "NULL"],
    ["archived-thread", "chat", `'${T}'`],
    ["job", "channel", "NULL"]
  ].map(
    ([id, type, archived]) => `INSERT INTO sessions (session_id, public_ref, started_at,
      last_activity, session_type, archived_at, name)
      VALUES ('${id}', 'ref-${id}', '${T}', '${T}', '${type}', ${archived}, 'Name ${id}')`
  ),
  `INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type, space_id, name)
     VALUES ('task-home', 'ref-task-home', '${T}', '${T}', 'chat', 'sp', 'Task home')`,
  `INSERT INTO space_conversations (space_id, session_id) VALUES ('sp', 'task-home')`,
  ...[
    ["agent-work", "work", "call-spawn-work"],
    ["agent-research", "research", "call-spawn-research"],
    ["agent-code", "code", "call-spawn-code"],
    ["agent-script", "research", "call-script:workflow:key:0:0"],
    ["agent-damaged", "research", "call-spawn-damaged"]
  ].map(
    ([id, mode, call]) => `INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
      session_type, parent_session_id, parent_run_id, parent_tool_call_id, metadata, name)
      VALUES ('${id}', 'ref-${id}', '${T}', '${T}', 'agent', 'owner-chat', 'r-own', '${call}',
        '${JSON.stringify({ agent: { mode } })}', 'Agent ${id}')`
  ),
  `INSERT INTO code_mode_scripts (script_ref, origin_session_ref, origin_run_id, origin_tool_call_id,
      profile_hash, status, version, attempt, created_at, updated_at, ended_at)
     VALUES ('script-1', 'ref-owner-chat', 'r-own', 'call-script', 'profile', 'succeeded', 1, 1,
       '${T}', '${T}', '${T}')`,
  ...[
    ["auto-once", "user_automation", "NULL", "thread-a"],
    ["auto-repeat", "user_automation", "NULL", "thread-a"],
    ["auto-system", "system", "NULL", "thread-a"],
    ["auto-urgent", "system", "'events'", "thread-a"],
    ["auto-archived", "user_automation", "NULL", "archived-thread"],
    ["auto-move", "user_automation", "NULL", "thread-a"]
  ].map(
    ([id, purpose, handler, thread]) => `INSERT INTO scheduled_tasks (task_id, automation_ref, name,
      prompt, triggers, created_at, thread_id, purpose, handler)
      VALUES ('${id}', 'ref-${id}', '${id}', 'Check.', '[]', '${T}', '${thread}', '${purpose}', ${handler})`
  ),
  `INSERT INTO space_tasks (item_id, space_id, stable_key, text, status, owner, created_at, updated_at)
     VALUES ('task-1', 'sp', 'task-1', 'Write the report', 'open', 'worker', '${T}', '${T}')`
]

const runs: ReadonlyArray<
  readonly [run: string, session: string, metadata: string, client?: string]
> = [
  ["r-own", "owner-chat", JSON.stringify(context(chat("owner-chat")))],
  ["r-sender", "other-chat", JSON.stringify(context(chat("owner-chat")))],
  ["r-auto-once", "job", JSON.stringify(context(automation("auto-once")))],
  ["r-auto-repeat", "job", JSON.stringify(context(automation("auto-repeat")))],
  ["r-system", "job", JSON.stringify(context(automation("auto-system")))],
  ["r-urgent", "job", JSON.stringify(context(automation("auto-urgent")))],
  ["r-occ-urgent", "job", JSON.stringify(context(automation("auto-urgent")))],
  ["r-occ-override", "job", JSON.stringify(context(automation("auto-system")))],
  ["r-archived", "job", JSON.stringify(context(automation("auto-archived")))],
  ["r-move", "job", JSON.stringify(context(automation("auto-move")))],
  [
    "r-task",
    "job",
    JSON.stringify(
      context(
        { kind: "task", item_id: "task-1", occurrence_id: "occ-1" },
        {
          item_id: "task-1",
          generation: 0
        }
      )
    )
  ],
  ["r-agent-work", "agent-work", JSON.stringify(context(chat("owner-chat")))],
  ["r-agent-research", "agent-research", JSON.stringify(context(chat("owner-chat")))],
  ["r-agent-code", "agent-code", JSON.stringify(context(chat("owner-chat")))],
  [
    "r-agent-script",
    "agent-script",
    JSON.stringify(context(chat("owner-chat"))),
    "spawn:r-own:call-script:workflow:key:0:0"
  ],
  ["r-agent-damaged", "agent-damaged", JSON.stringify({ run_context: { origin: "broken" } })],
  ["r-plain-damaged", "other-chat", JSON.stringify({ run_context: { origin: "broken" } })],
  ["r-unrecorded", "other-chat", "{}"]
]

const seed = (sql: SqlClient.SqlClient) =>
  Effect.forEach(
    [
      ...sessions,
      ...runs.map(
        ([run, session, metadata, client]) => `INSERT INTO chat_runs (run_id, session_id, status,
          started_at, updated_at, ended_at, metadata_json, assistant_message_id, client_id)
          VALUES ('${run}', '${session}', 'completed', '${T}', '${ENDED}', '${ENDED}',
            '${metadata}', 'am-${run}', ${client === undefined ? "NULL" : `'${client}'`})`
      ),
      `INSERT INTO tool_calls (run_id, session_id, tool_call_id, tool_name, arguments_json,
          changes_state, status, started_at, parent_tool_call_id, nesting, script_tool_call_id)
        VALUES ('r-own', 'owner-chat', 'call-script:workflow:key:0:0', 'spawn_agent', '{}', 1,
          'running', '${T}', 'call-script', 'workflow', 'call-script')`,
      `INSERT INTO script_agent_calls (run_id, tool_call_id, agent_key, launch)
        VALUES ('r-own', 'call-script:workflow:key:0:0', 'key', 0)`,
      `INSERT INTO automation_runs (id, task_id, automation_ref, started_at, ended_at, status,
          outcome, trigger_json)
        VALUES (1, 'auto-repeat', 'ref-auto-repeat', '${T}', '${T}', 'completed', 'finished',
          '{"source":"schedule"}')`,
      `INSERT INTO automation_runs (id, task_id, automation_ref, chat_run_id, started_at, ended_at,
          status, outcome, trigger_json)
        VALUES (2, 'auto-repeat', 'ref-auto-repeat', 'r-auto-repeat', '${T}', '${ENDED}', 'completed',
          'finished', '{"source":"schedule"}')`,
      `INSERT INTO entity_events (key, entity, entity_id, event, run_id, text, place, place_kind,
          occurred_at, shown)
        VALUES ('task-done:1', 'task', 'task-1', 'done', 'r-task', 'Done.', 'task-home', 'chat',
          '${ENDED}', 1)`
    ],
    (statement) => sql.unsafe(statement),
    { discard: true }
  )

const completed = (runId: string, result: string) =>
  ({
    kind: "run",
    runId,
    terminal: { status: "completed", result },
    now: ENDED
  }) as const

const occurrence = (runId: string, id: number): EndedAutomationRun => ({
  id,
  outcome: "finished",
  endedAt: ENDED,
  result: `Occurrence of ${runId}.`,
  error: null,
  chatRunId: runId,
  chatSessionId: null,
  skip: null
})

const inDatabase = <A>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown, never>) =>
  withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seed(sql)
      return yield* use(sql)
    }).pipe(Effect.provide(TestClock.layer()))
  )

const deliveriesTo = (sql: SqlClient.SqlClient, sessionId: string) =>
  sql<{
    readonly payload: string
  }>`SELECT payload FROM automation_deliveries ORDER BY delivery_id`.pipe(
    Effect.map((rows) =>
      rows
        .map((row) => JSON.parse(row.payload) as Record<string, unknown>)
        .filter(
          (payload) =>
            payload["sessionId"] === sessionId || payload["destinationSessionId"] === sessionId
        )
    )
  )

const resultsFor = (payloads: ReadonlyArray<Record<string, unknown>>) =>
  payloads
    .filter((payload) => payload["kind"] === "result")
    .map((payload) => payload["runIds"])
    .toSorted()

it("a worker's result goes to the chat that started it, once, however often endings are replayed", async () => {
  const delivered = await inDatabase((sql) =>
    Effect.gen(function* () {
      for (const run of ["r-agent-work", "r-agent-research", "r-agent-code"]) {
        yield* recordEnding(sql, completed(run, `Result of ${run}.`))
        yield* recordEnding(sql, completed(run, `Result of ${run}.`))
      }
      yield* reconcileEndings(sql)
      yield* reconcileEndings(sql)
      return resultsFor(yield* deliveriesTo(sql, "owner-chat"))
    })
  )
  expect(delivered).toEqual([["r-agent-code"], ["r-agent-research"], ["r-agent-work"]])
})

it("a chat's own run, and a run whose chat has other business, deliver nothing", async () => {
  const delivered = await inDatabase((sql) =>
    Effect.gen(function* () {
      yield* recordEnding(sql, completed("r-own", "Result of r-own."))
      yield* recordEnding(sql, completed("r-sender", "Result of r-sender."))
      yield* recordEnding(sql, completed("r-agent-script", "Result of r-agent-script."))
      yield* reconcileEndings(sql)
      return [
        ...(yield* deliveriesTo(sql, "owner-chat")),
        ...(yield* deliveriesTo(sql, "other-chat"))
      ]
    })
  )
  expect(delivered).toEqual([])
})

it("an Automation's result goes to the chat it is bound to now", async () => {
  const delivered = await inDatabase((sql) =>
    Effect.gen(function* () {
      yield* recordEnding(sql, completed("r-move", "Result of r-move."))
      yield* sql`UPDATE scheduled_tasks SET thread_id = 'thread-b' WHERE task_id = 'auto-move'`
      yield* reconcileEndings(sql)
      yield* reconcileEndings(sql)
      return {
        moved: (yield* deliveriesTo(sql, "thread-b")).length,
        old: (yield* deliveriesTo(sql, "thread-a")).length
      }
    })
  )
  expect(delivered).toEqual({ moved: 1, old: 0 })
})

it("a run with a corrupt context still ends: a worker tells its parent, a chat run says nothing", async () => {
  const outcome = await inDatabase((sql) =>
    Effect.gen(function* () {
      const worker = yield* recordEnding(sql, completed("r-agent-damaged", "Lost."))
      const plain = yield* recordEnding(sql, completed("r-plain-damaged", "Lost."))
      return {
        worker: worker?.status,
        plain: plain?.status,
        parent: resultsFor(yield* deliveriesTo(sql, "owner-chat")),
        own: yield* deliveriesTo(sql, "other-chat")
      }
    })
  )
  expect(outcome).toEqual({
    worker: "finished",
    plain: "finished",
    parent: [["r-agent-damaged"]],
    own: []
  })
})

it("an occurrence's ending takes the Automation's own purpose unless it asks for more than system", async () => {
  const purposes = await inDatabase((sql) =>
    Effect.gen(function* () {
      const userAutomationAsSystem = yield* recordEnding(sql, {
        kind: "occurrence",
        purpose: "system",
        run: occurrence("r-auto-once", 11)
      })
      const systemAsUserAutomation = yield* recordEnding(sql, {
        kind: "occurrence",
        purpose: "user_automation",
        run: occurrence("r-occ-override", 12)
      })
      const systemAsSystem = yield* recordEnding(sql, {
        kind: "occurrence",
        purpose: "system",
        run: occurrence("r-occ-urgent", 13)
      })
      return [
        userAutomationAsSystem?.purpose,
        systemAsUserAutomation?.purpose,
        systemAsSystem?.purpose
      ]
    })
  )
  expect(purposes).toEqual(["user_automation", "user_automation", "system"])
})

it("an ending the chat already shows as an event is not shown a second time", async () => {
  const shown = await inDatabase((sql) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO entity_events (key, entity, entity_id, event, run_id, text, place,
          place_kind, occurred_at, shown)
        VALUES ('twin:1', 'task', 'task-1', 'done', 'r-move', 'Done.', 'thread-a', 'chat',
          ${ENDED}, 1)`
      const plain = yield* recordEnding(sql, completed("r-auto-once", "Result of r-auto-once."))
      const twinned = yield* recordEnding(sql, completed("r-move", "Result of r-move."))
      return [plain?.shown, twinned?.shown]
    })
  )
  expect(shown).toEqual([true, false])
})

it("a run tells its chat, once per call, up to a limit; a chat's own run has no one to tell", async () => {
  const outcome = await inDatabase((sql) =>
    Effect.gen(function* () {
      const tell = (run: string, call: string) =>
        recordTell(sql, { runId: run, toolCallId: call, text: `Note ${call}.` })
      const first = yield* tell("r-agent-work", "call-1")
      const again = yield* tell("r-agent-work", "call-1")
      const own = yield* tell("r-own", "call-1")
      const sender = yield* tell("r-sender", "call-1")
      const automation = yield* tell("r-auto-once", "call-1")
      const told = [first.kind]
      for (let call = 2; call <= TELL_LIMIT + 1; call += 1)
        told.push((yield* tell("r-agent-work", `call-${call}`)).kind)
      return {
        first,
        again,
        own: own.kind,
        sender: sender.kind,
        automation,
        told,
        toParent: (yield* deliveriesTo(sql, "owner-chat")).filter(
          (payload) => payload["progress"] === true
        ).length,
        toAutomationChat: (yield* deliveriesTo(sql, "thread-a")).length
      }
    })
  )
  expect(outcome).toMatchObject({
    first: { kind: "told", chatId: "owner-chat" },
    again: { kind: "again", chatId: "owner-chat" },
    own: "refused",
    sender: "refused",
    automation: { kind: "told", chatId: "thread-a" },
    told: [...Array.from({ length: TELL_LIMIT }, () => "told"), "refused"],
    toParent: TELL_LIMIT,
    toAutomationChat: 1
  })
})
