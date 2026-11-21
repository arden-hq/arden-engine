import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { TestClock } from "effect/testing"
import { expect, it } from "vitest"
import type { EndedAutomationRun } from "../src/persistence/sqlite/automation-run-outcome.js"
import { reconcileEndings, recordEnding } from "../src/persistence/sqlite/run-ending.js"
import { recordTell } from "../src/persistence/sqlite/run-tell.js"
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

it("records where each run's ending and tells go, and replays stored endings", async () => {
  const capture = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seed(sql)
      const endings: Record<string, unknown> = {}
      for (const [run] of runs.filter(([run]) => !run.startsWith("r-occ")))
        endings[run] = yield* recordEnding(sql, completed(run, `Result of ${run}.`))
      endings["r-missing"] = yield* recordEnding(sql, completed("r-missing", "Lost."))
      endings["r-occ-urgent"] = yield* recordEnding(sql, {
        kind: "occurrence",
        purpose: "system",
        run: occurrence("r-occ-urgent", 11)
      })
      endings["r-occ-override"] = yield* recordEnding(sql, {
        kind: "occurrence",
        purpose: "user_automation",
        run: occurrence("r-occ-override", 12)
      })
      endings["r-agent-work again"] = yield* recordEnding(
        sql,
        completed("r-agent-work", "Result of r-agent-work.")
      )
      const tells: Record<string, unknown> = {}
      for (const run of [
        "r-own",
        "r-sender",
        "r-auto-once",
        "r-system",
        "r-task",
        "r-agent-work",
        "r-agent-script",
        "r-agent-damaged",
        "r-plain-damaged",
        "r-archived",
        "r-missing"
      ])
        tells[run] = yield* recordTell(sql, {
          runId: run,
          toolCallId: "tell-1",
          text: `Note from ${run}.`
        })
      tells["r-agent-work again"] = yield* recordTell(sql, {
        runId: "r-agent-work",
        toolCallId: "tell-1",
        text: "Note from r-agent-work."
      })
      yield* sql`UPDATE scheduled_tasks SET thread_id = 'thread-b' WHERE task_id = 'auto-move'`
      yield* reconcileEndings(sql)
      yield* reconcileEndings(sql)
      const rows = {
        endings: yield* sql`SELECT * FROM run_endings ORDER BY run_id`,
        tells: yield* sql`SELECT * FROM run_tells ORDER BY run_id, n`,
        deliveries: (yield* sql<{
          readonly delivery_id: string
          readonly subject: string
          readonly body: string
          readonly payload: string
          readonly status: string
          readonly created_at: string
          readonly communication_sequence: number | null
        }>`SELECT delivery_id, subject, body, payload, status, created_at, communication_sequence
          FROM automation_deliveries ORDER BY delivery_id`).map((row) => ({
          ...row,
          payload: JSON.parse(row.payload)
        }))
      }
      return { endings, tells, rows }
    }).pipe(Effect.provide(TestClock.layer()))
  )
  const ending = (run: string) =>
    (capture.rows.endings as ReadonlyArray<Record<string, unknown>>).find(
      (row) => row["run_id"] === run
    )
  const deliveriesTo = (sessionId: string) =>
    capture.rows.deliveries.filter(
      (row) => row.payload.sessionId === sessionId || row.payload.destinationSessionId === sessionId
    )
  const kinds = (sessionId: string) =>
    deliveriesTo(sessionId)
      .map(
        (row) =>
          `${row.payload.kind}:${JSON.stringify(row.payload.runIds ?? row.payload.sourceRunId ?? row.payload.source)}`
      )
      .toSorted()
  expect(kinds("owner-chat")).toEqual([
    'result:["r-agent-code"]',
    'result:["r-agent-damaged"]',
    'result:["r-agent-damaged"]',
    'result:["r-agent-research"]',
    'result:["r-agent-work"]',
    'result:["r-agent-work"]'
  ])
  expect(ending("r-agent-script")?.["place_kind"]).toBe("sender")
  expect(ending("r-agent-damaged")).toMatchObject({ place_kind: "parent", detail: "damaged" })
  expect(ending("r-plain-damaged")).toMatchObject({
    place_kind: "own",
    delivery_error: "The run's context is corrupt"
  })
  expect(ending("r-unrecorded")?.["place_kind"]).toBe("own")
  expect(capture.endings["r-missing"]).toBeUndefined()
  expect(ending("r-occ-urgent")?.["purpose"]).toBe("user_automation")
  expect(ending("r-occ-override")?.["purpose"]).toBe("user_automation")
  expect(ending("r-system")?.["purpose"]).toBe("system")
  expect(ending("r-move")?.["place"]).toBe("thread-a")
  expect(deliveriesTo("thread-b").length).toBe(1)
  expect(
    deliveriesTo("thread-a").some((row) => JSON.stringify(row.payload).includes("r-move"))
  ).toBe(false)
  expect(ending("r-task")?.["shown"]).toBe(0)
  expect(capture.tells["r-agent-work again"]).toMatchObject({ kind: "again", n: 1 })
})
