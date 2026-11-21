import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import type { SpaceJobSql } from "./space-jobs.js"
import { countsAsRun } from "./automation-skip-record.js"
import { activeRunStatusList } from "./status-sets.js"
import { taskMayWakeSql } from "./task-wake.js"

const CHUNK_SIZE = 50

export interface SpaceJobRecoveryCursor {
  readonly stage: "spaces" | "reviews" | "tasks" | "unstarted" | "due"
  readonly after: string | undefined
}

export const makeSpaceJobRecovery = (options: {
  readonly sql: SqlClient.SqlClient
  readonly syncSpace: SpaceJobSql["syncSpace"]
  readonly syncTask: (itemId: string, now: string) => ReturnType<SpaceJobSql["syncSpace"]>
  readonly stopWork: (automationId: string) => ReturnType<SpaceJobSql["stopTask"]>
  readonly queueTaskWake: SpaceJobSql["queueTaskWake"]
  readonly materializeDue: SpaceJobSql["materializeDue"]
}): SpaceJobSql["reconcile"] =>
  Effect.fn("SpaceJobSql.reconcileChunk")(function* (now, cursor) {
    const { sql } = options
    const { stage, after } = cursor ?? { stage: "spaces", after: undefined }
    switch (stage) {
      case "spaces": {
        const rows = yield* sql<{ readonly space_id: string }>`
        SELECT space_id FROM spaces
        WHERE json_extract(inference_policy, '$.enabled') = 1 AND archived_at IS NULL
          AND ${after === undefined ? sql`1` : sql`space_id > ${after}`}
        ORDER BY space_id LIMIT ${CHUNK_SIZE}`
        for (const row of rows) yield* options.syncSpace(row.space_id, now)
        const next = rows.at(-1)?.space_id
        return next === undefined ? { stage: "reviews", after: undefined } : { stage, after: next }
      }
      case "reviews": {
        const rows = yield* sql<{ readonly task_id: string }>`
        WITH authority AS MATERIALIZED (${automationRecoveryAuthority(sql)})
        SELECT keyed.task_id FROM (
          SELECT queue.task_id FROM automation_event_queue AS queue
          WHERE substr(queue.task_id, 1, 6) = 'space:'
          UNION
          SELECT authority.automation_id FROM authority
          WHERE substr(authority.automation_id, 1, 6) = 'space:'
        ) AS keyed
        WHERE ${after === undefined ? sql`1` : sql`keyed.task_id > ${after}`}
          AND NOT EXISTS (SELECT 1 FROM spaces WHERE space_id = substr(keyed.task_id, 7)
            AND archived_at IS NULL)
        ORDER BY keyed.task_id LIMIT ${CHUNK_SIZE}`
        for (const row of rows) yield* options.stopWork(row.task_id)
        const next = rows.at(-1)?.task_id
        return next === undefined ? { stage: "tasks", after: undefined } : { stage, after: next }
      }
      case "tasks": {
        const rows = yield* sql<{ readonly item_id: string }>`
        WITH authority AS MATERIALIZED (${automationRecoveryAuthority(sql)})
        SELECT item.item_id
        FROM space_tasks AS item
        LEFT JOIN authority ON authority.automation_id = 'task:' || item.item_id
        WHERE ${after === undefined ? sql`1` : sql`item.item_id > ${after}`}
          AND (authority.automation_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM automation_event_queue AS queue
              WHERE queue.task_id = 'task:' || item.item_id))
        ORDER BY item.item_id LIMIT ${CHUNK_SIZE}`
        for (const row of rows) yield* options.syncTask(row.item_id, now)
        const next = rows.at(-1)?.item_id
        return next === undefined
          ? { stage: "unstarted", after: undefined }
          : { stage, after: next }
      }
      case "unstarted": {
        const rows = yield* sql<{ readonly item_id: string }>`
        SELECT item.item_id FROM space_tasks AS item
        WHERE ${taskMayWakeSql(sql, "item")}
          AND ${after === undefined ? sql`1` : sql`item.item_id > ${after}`}
          AND (item.next_attempt_at IS NULL OR item.next_attempt_at <= ${now})
          AND NOT EXISTS (SELECT 1 FROM automation_runs AS attempt
            WHERE attempt.item_id = item.item_id AND ${countsAsRun(sql, sql`attempt`)})
          AND NOT EXISTS (SELECT 1 FROM automation_runs AS attempt
            WHERE attempt.task_id = 'task:' || item.item_id AND ${countsAsRun(sql, sql`attempt`)})
          AND NOT EXISTS (SELECT 1 FROM automation_event_queue AS pending
            WHERE pending.task_id = 'task:' || item.item_id)
        ORDER BY item.item_id LIMIT ${CHUNK_SIZE}`
        for (const row of rows)
          yield* options.queueTaskWake(row.item_id, now, { kind: "continuation" })
        const next = rows.at(-1)?.item_id
        return next === undefined ? { stage: "due", after: undefined } : { stage, after: next }
      }
      case "due":
        yield* options.materializeDue(now)
        return undefined
    }
  })

export const automationRecoveryAuthority = (sql: SqlClient.SqlClient): Statement.Fragment => sql`
          SELECT COALESCE(json_extract(metadata_json, '$.run_policy.automation_id'),
            json_extract(metadata_json, '$.automation.task_id')) AS automation_id
          -- Named, because idx_chat_runs_automation also holds this value and
          -- SQLite would read all of it instead of the short list of active runs.
          FROM chat_runs INDEXED BY idx_chat_runs_active WHERE status IN ${activeRunStatusList}
          UNION
          SELECT COALESCE(json_extract(run.metadata_json, '$.run_policy.automation_id'),
            json_extract(run.metadata_json, '$.automation.task_id')) AS automation_id
          -- CROSS JOIN keeps this order: the few open questions first, each run by its id.
          FROM run_questions AS question CROSS JOIN chat_runs AS run ON run.run_id = question.run_id
          WHERE question.resolution IS NULL AND question.closed_at IS NULL
          UNION
          SELECT task_id AS automation_id FROM automation_runs WHERE status = 'running'
`
