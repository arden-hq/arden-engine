import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { givesUp } from "../src/persistence/sqlite/automation-auto-pause.js"
import { outcomeSql } from "../src/persistence/sqlite/automation-run-outcome.js"
import { countsAsRun } from "../src/persistence/sqlite/automation-skip-record.js"
import { failureRows } from "../src/persistence/sqlite/inbox-failure-rows.js"
import {
  automationFailureEntries,
  type FailureRow
} from "../src/persistence/sqlite/inbox-failures.js"
import { failureNeedsOwner } from "../src/persistence/sqlite/run-attention.js"
import { taskOpenSql } from "../src/persistence/sqlite/task-status-sql.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// The Inbox's failures used to be found by reading every failed ending, every
// failure event and every failed attempt on record. They now start from the
// recent failures and the stuck Tasks. This runs the old SQL (kept only here)
// and the new one on the same rows and expects the same Inbox entries.

const DAY = 86_400_000
const at = (days: number) => new Date(Date.now() - days * DAY).toISOString()
const PREFIX = "automation-failed:"

/** The failures read before migration 151. */
const oldFailureRows = (sql: SqlClient.SqlClient, cutoff: string) => sql<FailureRow>`
  WITH latest_completed AS (
    SELECT task_id AS completed_task_id, MAX(julianday(started_at)) AS completed_started
    FROM automation_runs
    WHERE status = 'completed' AND task_id IS NOT NULL
      AND ${countsAsRun(sql, sql`automation_runs`)}
    GROUP BY task_id
  ),
  candidate AS (
    SELECT COALESCE(attempt.id, 0) AS id, attempt.task_id AS task_id, ending.run_id AS chat_run_id,
      COALESCE(attempt.started_at, ending.occurred_at) AS started_at,
      CASE WHEN attempt.id IS NULL THEN ending.text ELSE attempt.error END AS error,
      chat.error_code AS error_code,
      COALESCE(scheduled.owner_space_id, json_extract(attempt.origin, '$.space_id'),
        (SELECT space_id FROM space_tasks WHERE item_id = COALESCE(attempt.item_id,
          json_extract(chat.metadata_json, '$.run_context.task.item_id'))),
        session.space_id) AS space_id,
      COALESCE(attempt.item_id,
        json_extract(chat.metadata_json, '$.run_context.task.item_id')) AS item_id,
      chat.status AS chat_status
    FROM run_endings AS ending
    JOIN chat_runs AS chat ON chat.run_id = ending.run_id
    JOIN sessions AS session ON session.session_id = chat.session_id
    LEFT JOIN automation_runs AS attempt ON attempt.chat_run_id = ending.run_id
    LEFT JOIN scheduled_tasks AS scheduled ON scheduled.task_id = attempt.task_id
    WHERE ${failureNeedsOwner(sql)}
      AND (attempt.id IS NULL
        OR (attempt.status = 'failed' AND ${outcomeSql(sql, sql`attempt`)} = 'failed'))
    UNION ALL
    SELECT attempt.id, attempt.task_id, NULL, attempt.started_at, attempt.error, NULL,
      COALESCE(scheduled.owner_space_id, json_extract(attempt.origin, '$.space_id')),
      attempt.item_id, NULL
    FROM entity_events AS event
    JOIN automation_runs AS attempt
      ON attempt.id = CAST(substr(event.key, ${PREFIX.length + 1}) AS INTEGER)
    LEFT JOIN scheduled_tasks AS scheduled ON scheduled.task_id = attempt.task_id
    WHERE event.entity = 'automation' AND event.event = 'failed'
      AND attempt.status = 'failed' AND ${outcomeSql(sql, sql`attempt`)} = 'failed'
    UNION ALL
    SELECT attempt.id, attempt.task_id, attempt.chat_run_id, attempt.started_at, attempt.error,
      (SELECT error_code FROM chat_runs WHERE run_id = attempt.chat_run_id),
      COALESCE((SELECT owner_space_id FROM scheduled_tasks WHERE task_id = attempt.task_id),
        json_extract(attempt.origin, '$.space_id'),
        (SELECT space_id FROM space_tasks WHERE item_id = attempt.item_id)),
      attempt.item_id,
      (SELECT status FROM chat_runs WHERE run_id = attempt.chat_run_id)
    FROM automation_runs AS attempt
    WHERE attempt.status = 'failed' AND ${outcomeSql(sql, sql`attempt`)} = 'failed'
      AND NOT EXISTS (SELECT 1 FROM run_endings
        WHERE run_id = attempt.chat_run_id AND decided = 1 AND status = 'failed')
      AND NOT EXISTS (SELECT 1 FROM entity_events
        WHERE key = ${PREFIX} || attempt.id)
  )
  SELECT id, task_id, chat_run_id, started_at, error, error_code, space_id
  FROM candidate
  LEFT JOIN latest_completed ON latest_completed.completed_task_id = candidate.task_id
  WHERE COALESCE(candidate.chat_status, '') <> 'cancelled'
    AND COALESCE(latest_completed.completed_started > julianday(candidate.started_at), 0) = 0
    AND (
      julianday(candidate.started_at) IS NULL OR
      julianday(candidate.started_at) >= julianday(${cutoff}) OR
      EXISTS (
        SELECT 1 FROM space_tasks AS stuck
        WHERE stuck.item_id = candidate.item_id
          AND ${taskOpenSql("stuck")} AND stuck.owner = 'worker' AND stuck.next_attempt_at IS NULL
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM space_tasks AS task
      WHERE task.item_id = candidate.item_id AND ${taskOpenSql("task")}
        AND task.next_attempt_at IS NOT NULL
    )`

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
    // A counted run completed after 3; a skipped one completed after 4.
    { id: 4, task: "auto-2", daysAgo: 1.5, status: "completed", outcome: "finished" },
    { id: 5, task: "auto-1", daysAgo: 0.5, status: "failed" },
    { id: 6, task: "auto-1", daysAgo: 0.2, status: "completed", outcome: "skipped:prefilter" },
    { id: 7, task: null, daysAgo: 60, status: "failed", item: "task-stuck" },
    { id: 8, task: "auto-3", daysAgo: 3, status: "failed" },
    { id: 9, task: "auto-3", daysAgo: 4, status: "failed" },
    { id: 10, task: null, daysAgo: 50, status: "failed", item: "task-retrying" },
    { id: 11, task: null, daysAgo: 70, status: "failed", run: "r-11" },
    { id: 12, task: "auto-3", daysAgo: 2, status: "failed", run: "r-12" },
    { id: 13, task: "auto-3", daysAgo: "not a time", status: "failed" },
    { id: 14, task: null, daysAgo: 90, status: "failed", item: "task-done" },
    { id: 15, task: "auto-2", daysAgo: 0.1, status: "failed", outcome: "superseded" },
    { id: 16, task: "auto-3", daysAgo: 30, status: "failed", run: "r-16" }
  ]
  const endings: ReadonlyArray<Ending> = [
    { run: "r-1", daysAgo: 1 },
    { run: "r-2", daysAgo: 40 },
    { run: "r-3", daysAgo: 2 },
    { run: "r-11", daysAgo: 70, item: "task-stuck" },
    { run: "r-12", daysAgo: 2, chatStatus: "cancelled" },
    { run: "r-16", daysAgo: 1 },
    // Endings with no attempt: recent, equal times, old on a stuck Task, old,
    // a parent's agent, a plain chat run.
    { run: "r-e1", daysAgo: 1, purpose: "task_execution", item: "task-open" },
    { run: "r-e2", daysAgo: 1, purpose: "task_execution", item: "task-open" },
    { run: "r-e0", daysAgo: 1, purpose: "task_execution", item: "task-open" },
    { run: "r-e3", daysAgo: 45, purpose: "task_execution", item: "task-stuck" },
    { run: "r-e4", daysAgo: 45, purpose: "task_execution", item: "task-done" },
    { run: "r-e5", daysAgo: 1, purpose: "task_execution", placeKind: "parent" },
    { run: "r-e6", daysAgo: 1, purpose: "chat" },
    { run: "r-e7", daysAgo: 2, purpose: "task_execution", item: "task-retrying" }
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
    // Failure events: one per attempt, on attempts with no ending.
    ...[8, 2, 5].map(
      (
        id
      ) => `INSERT INTO entity_events (key, entity, entity_id, event, text, place_kind, occurred_at, shown)
        VALUES ('${PREFIX}${id}', 'automation', 'auto', 'failed', 'Failed.', 'own', '${at(1)}', 1)`
    )
  ]
  return Effect.forEach(statements, (statement) => sql.unsafe(statement), { discard: true })
}

// The Inbox orders the groups by time and key itself.
const entries = (rows: ReadonlyArray<FailureRow>) =>
  automationFailureEntries({
    failures: rows,
    pauses: [],
    spacePauses: [],
    spaceTitles: new Map([["sp", "Space"]]),
    marks: new Map()
  }).toSorted((left, right) => left.key.localeCompare(right.key))

it("the Inbox's failures match the old read of every failure on record", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seed(sql)
      for (const days of [7, 0.3, 3, 65]) {
        const cutoff = at(days)
        const next = yield* failureRows(sql, cutoff)
        const old = yield* oldFailureRows(sql, cutoff)
        const label = `cutoff ${days} days`
        expect(next.map((row) => JSON.stringify(row)).toSorted(), label).toEqual(
          old.map((row) => JSON.stringify(row)).toSorted()
        )
        expect(entries(next), label).toEqual(entries(old))
        if (days === 7) {
          // Endings with no attempt first, by run id; 16's ending is recent but
          // its attempt started 30 days ago, so it stays out.
          expect(next.map((row) => row.id)).toEqual([0, 0, 0, 0, 1, 5, 7, 8, 9, 11, 13])
          expect(next.slice(0, 4).map((row) => row.chat_run_id)).toEqual([
            "r-e0",
            "r-e1",
            "r-e2",
            "r-e3"
          ])
        }
      }
    })
  )
})

it("the Inbox's failures read the recent and stuck lists, not every failure", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [statement, parameters] = failureRows(sql, at(7)).compile()
      const rows = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${statement}`,
        parameters
      )
      const plan = rows.map((row) => row.detail)
      expect(
        plan.filter((step) =>
          /^SCAN (ending|event|attempt|chat|automation_runs|run_endings)\b/.test(step)
        )
      ).toEqual([])
      for (const index of [
        "idx_automation_runs_status_started",
        "idx_run_endings_status_at",
        "idx_space_tasks_stuck",
        "idx_automation_runs_counted_completed"
      ])
        expect(
          plan.some((step) => step.includes(index)),
          index
        ).toBe(true)
    })
  )
})

it("an Automation gives up on its third failed run in a row since it last gave up", async () => {
  await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* seed(sql)
      for (const id of [21, 22, 23, 24, 25])
        yield* sql`INSERT INTO automation_runs (id, task_id, automation_ref, started_at, ended_at,
            status, outcome) VALUES (${id}, 'auto-4', 'ref-auto-4', ${at(1)}, ${at(1)}, 'failed', 'failed')`
      const givesUpAt = (attemptId: number) =>
        givesUp(sql, { automationId: "auto-4", attemptId, chatRunId: null })
      expect(yield* givesUpAt(22)).toBeUndefined()
      expect(yield* givesUpAt(23)).toEqual({ kind: "streak" })
      // 23 moved past its item; its failed event names that item's run.
      yield* sql`UPDATE automation_runs SET chat_run_id = 'r-e6' WHERE id = 23`
      yield* sql`INSERT INTO entity_events (key, entity, entity_id, event, run_id, text, place_kind,
          occurred_at, shown) VALUES (${`${PREFIX}23`}, 'automation', 'auto-4', 'failed',
          'r-e6', 'Skipped.', 'own', ${at(1)}, 1)`
      expect(yield* givesUpAt(25)).toBeUndefined()
      expect(yield* givesUpAt(26)).toEqual({ kind: "streak" })
    })
  )
})
