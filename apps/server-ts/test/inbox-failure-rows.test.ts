import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import {
  ITEM_GIVE_UP,
  endStreak,
  givesUp
} from "../src/persistence/sqlite/automation-auto-pause.js"
import { failureRows } from "../src/persistence/sqlite/inbox-failure-rows.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const DAY = 86_400_000
const NOW = Date.now()
const at = (days: number) => new Date(NOW - days * DAY).toISOString()
const PREFIX = "automation-failed:"

interface Attempt {
  readonly id: number
  readonly task: string | null
  readonly daysAgo: number | string
  readonly status: "failed" | "completed" | "cancelled"
  readonly outcome?: string | null
  readonly run?: string
  readonly item?: string
}

interface Ending {
  readonly run: string
  readonly daysAgo: number
  readonly purpose?: string
  readonly placeKind?: string
  readonly item?: string
  readonly chatStatus?: string
}

const seed = (sql: SqlClient.SqlClient) => {
  const attempts: ReadonlyArray<Attempt> = [
    { id: 1, task: "auto-1", daysAgo: 1, status: "failed", run: "r-1" },
    { id: 2, task: "auto-1", daysAgo: 40, status: "failed", run: "r-2" },
    { id: 3, task: "auto-2", daysAgo: 2, status: "failed", run: "r-3" },
    {
      id: 4,
      task: "auto-2",
      daysAgo: 1.5,
      status: "completed",
      outcome: "finished"
    },
    { id: 5, task: "auto-1", daysAgo: 0.5, status: "failed" },
    {
      id: 6,
      task: "auto-1",
      daysAgo: 0.2,
      status: "completed",
      outcome: "skipped:prefilter"
    },
    { id: 7, task: null, daysAgo: 60, status: "failed", item: "task-stuck" },
    { id: 8, task: "auto-3", daysAgo: 3, status: "failed" },
    { id: 9, task: "auto-3", daysAgo: 4, status: "failed" },
    {
      id: 10,
      task: null,
      daysAgo: 50,
      status: "failed",
      item: "task-retrying"
    },
    { id: 11, task: null, daysAgo: 70, status: "failed", run: "r-11" },
    { id: 12, task: "auto-3", daysAgo: 2, status: "failed", run: "r-12" },
    { id: 13, task: "auto-3", daysAgo: "not a time", status: "failed" },
    { id: 14, task: null, daysAgo: 90, status: "failed", item: "task-done" },
    {
      id: 15,
      task: "auto-2",
      daysAgo: 0.1,
      status: "failed",
      outcome: "superseded"
    },
    { id: 16, task: "auto-3", daysAgo: 30, status: "failed", run: "r-16" }
  ]
  const endings: ReadonlyArray<Ending> = [
    { run: "r-1", daysAgo: 1 },
    { run: "r-2", daysAgo: 40 },
    { run: "r-3", daysAgo: 2 },
    { run: "r-11", daysAgo: 70, item: "task-stuck" },
    { run: "r-12", daysAgo: 2, chatStatus: "cancelled" },
    { run: "r-16", daysAgo: 1 },
    { run: "r-e1", daysAgo: 1, purpose: "task_execution", item: "task-open" },
    { run: "r-e2", daysAgo: 1, purpose: "task_execution", item: "task-open" },
    { run: "r-e0", daysAgo: 1, purpose: "task_execution", item: "task-open" },
    { run: "r-e3", daysAgo: 45, purpose: "task_execution", item: "task-stuck" },
    { run: "r-e4", daysAgo: 45, purpose: "task_execution", item: "task-done" },
    { run: "r-e5", daysAgo: 1, purpose: "task_execution", placeKind: "parent" },
    { run: "r-e6", daysAgo: 1, purpose: "chat" },
    {
      run: "r-e7",
      daysAgo: 2,
      purpose: "task_execution",
      item: "task-retrying"
    }
  ]
  const time = (daysAgo: number | string) => (typeof daysAgo === "string" ? daysAgo : at(daysAgo))
  const statements = [
    `INSERT INTO spaces (space_id, name, name_key, created_at, updated_at)
       VALUES ('sp', 'Space', 'space', '${at(100)}', '${at(100)}')`,
    `INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type, space_id)
       VALUES ('chat', 'ref-chat', '${at(100)}', '${at(1)}', 'chat', 'sp'),
              ('thread', 'ref-thread', '${at(100)}', '${at(1)}', 'chat', NULL)`,
    ...["auto-1", "auto-2", "auto-3", "auto-4"].map(
      (
        id
      ) => `INSERT INTO scheduled_tasks (task_id, automation_ref, name, prompt, triggers, created_at, thread_id)
        VALUES ('${id}', 'ref-${id}', '${id}', 'Check.', '[]', '${at(100)}', 'thread')`
    ),
    ...(
      [
        ["task-stuck", "open", "worker", "NULL"],
        ["task-retrying", "open", "worker", `'${at(-1)}'`],
        ["task-open", "open", "user", "NULL"],
        ["task-done", "done", "worker", "NULL"]
      ] as const
    ).map(
      ([id, status, owner, next]) =>
        `INSERT INTO space_tasks (item_id, space_id, stable_key, text, status, owner, created_at, updated_at, next_attempt_at)
         VALUES ('${id}', 'sp', '${id}', '${id}', '${status}', '${owner}', '${at(100)}', '${at(1)}', ${next})`
    ),
    ...endings.map(
      (
        ending
      ) => `INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at, ended_at,
          metadata_json, assistant_message_id, error_code)
        VALUES ('${ending.run}', 'chat', '${ending.chatStatus ?? "error"}', '${at(ending.daysAgo)}',
          '${at(ending.daysAgo)}', '${at(ending.daysAgo)}',
          '${JSON.stringify({ turn_id: "t", run_context: { task: ending.item === undefined ? null : { item_id: ending.item, generation: 0 } } })}',
          'am-${ending.run}', 'provider_error')`
    ),
    ...attempts.map(
      (
        attempt
      ) => `INSERT INTO automation_runs (id, task_id, automation_ref, chat_run_id, started_at, ended_at,
          status, error, outcome, item_id, task_generation)
        VALUES (${attempt.id}, ${attempt.task === null ? "NULL" : `'${attempt.task}'`},
          ${attempt.task === null ? "NULL" : `'ref-${attempt.task}'`},
          ${attempt.run === undefined ? "NULL" : `'${attempt.run}'`}, '${time(attempt.daysAgo)}',
          '${time(attempt.daysAgo)}', '${attempt.status}', 'Failed ${attempt.id}.',
          ${attempt.outcome === null ? "NULL" : `'${attempt.outcome ?? attempt.status}'`},
          ${attempt.item === undefined ? "NULL" : `'${attempt.item}'`},
          ${attempt.item === undefined ? "NULL" : "0"})`
    ),
    ...endings.map(
      (
        ending
      ) => `INSERT INTO run_endings (run_id, purpose, status, text, place, place_kind, occurred_at,
          shown, decided)
        VALUES ('${ending.run}', '${ending.purpose ?? "user_automation"}', 'failed', 'Ending ${ending.run}.',
          'chat', '${ending.placeKind ?? "own"}', '${at(ending.daysAgo)}', 1, 1)`
    ),
    ...[8, 2, 5, 15].map(
      (
        id
      ) => `INSERT INTO entity_events (key, entity, entity_id, event, text, place_kind, occurred_at, shown)
        VALUES ('${PREFIX}${id}', 'automation', 'auto', 'failed', 'Failed.', 'own', '${at(1)}', 1)`
    )
  ]
  return Effect.forEach(statements, (statement) => sql.unsafe(statement), {
    discard: true
  })
}

it("the Inbox lists recent failures and those of stuck Tasks, and no failure that was handled or superseded", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seed(sql)
      const rows = yield* failureRows(sql, at(7))
      expect(rows.map((row) => row.id)).toEqual([0, 0, 0, 0, 1, 5, 7, 8, 9, 11, 13])
      expect(rows.slice(0, 4).map((row) => row.chat_run_id)).toEqual([
        "r-e0",
        "r-e1",
        "r-e2",
        "r-e3"
      ])
    })
  )
})

it("a failure streak ends when a run does its work and does not carry to the next item", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seed(sql)
      const givesUpAt = (attemptId: number, item: string) =>
        givesUp(sql, {
          automationId: "auto-4",
          attemptId,
          chatRunId: null,
          item
        })
      for (const attemptId of [21, 22]) expect(yield* givesUpAt(attemptId, "a")).toBeUndefined()
      yield* endStreak(sql, "auto-4")
      for (const attemptId of [23, 24]) expect(yield* givesUpAt(attemptId, "a")).toBeUndefined()
      for (const attemptId of [25, 25, 26]) expect(yield* givesUpAt(attemptId, "b")).toBeUndefined()
      expect(yield* givesUpAt(27, "b")).toEqual({ kind: "streak" })
    })
  )
})

it("an item job keeps its item when the provider refuses the run", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seed(sql)
      yield* sql`UPDATE chat_runs SET error_code = 'provider_auth' WHERE run_id = 'r-e6'`
      yield* sql`INSERT INTO automation_runs (id, task_id, automation_ref, started_at, ended_at,
          status, outcome) VALUES (21, 'auto-4', 'ref-auto-4', ${at(1)}, ${at(1)}, 'failed', 'failed')`
      const cause = yield* givesUp(sql, {
        automationId: "auto-4",
        attemptId: 21,
        chatRunId: "r-e6",
        item: "a"
      })
      expect(cause && ITEM_GIVE_UP[cause.kind]).toBe("keep")
    })
  )
})
