import { countsAsRun } from "./automation-skip-record.js"
import type { SpaceTaskResult } from "@arden-hq/protocol/spaces/work"
import { SpaceTaskResultSchema } from "@arden-hq/protocol/effect/spaces/work"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { WorkStoreError } from "../work/store.js"
import { decodeJson } from "./json.js"
import { workError } from "./work-records.js"
import { quietRunOutcome } from "./run-outcomes.js"

export const readTaskResults = Effect.fn("SqliteWorkStore.readTaskResults")(function* (
  sql: SqlClient.SqlClient,
  itemIds: ReadonlyArray<string>
): Effect.fn.Return<ReadonlyArray<SpaceTaskResult>, WorkStoreError> {
  if (itemIds.length === 0) return []
  const rows = yield* sql<{ readonly result: string }>`
    WITH selected AS (SELECT item_id FROM space_tasks WHERE item_id IN ${sql.in(itemIds)}),
    candidates AS (
      SELECT item.item_id, event.created_at, 1 AS priority,
        json_object('result_key', 'event:' || event.event_id, 'summary', event.result_summary, 'item_id', item.item_id, 'text', event.summary, 'created_at', event.created_at,
          'source', json_object('kind', 'event', 'event_id', event.event_id)) AS result
      FROM selected AS item JOIN space_task_events AS event ON event.event_id = (
        SELECT event_id FROM space_task_events WHERE item_id = item.item_id AND content_kind = 'result'
        ORDER BY created_at DESC, event_id DESC LIMIT 1
      )
      UNION ALL
      SELECT item.item_id, attempt.ended_at, 0,
        json_object('result_key', 'attempt:' || attempt.id, 'summary', NULL, 'item_id', item.item_id, 'text', attempt.result, 'created_at', attempt.ended_at,
          'source', json_object('kind', 'attempt', 'attempt_id', attempt.id, 'run_id', attempt.chat_run_id))
      FROM selected AS item JOIN automation_runs AS attempt ON attempt.id = (
        SELECT candidate.id FROM automation_runs AS candidate
        LEFT JOIN chat_runs AS run ON run.run_id = candidate.chat_run_id
        WHERE candidate.item_id = item.item_id AND ${countsAsRun(sql, sql`candidate`)}
          AND candidate.ended_at IS NOT NULL AND length(trim(candidate.result)) > 0
          AND NOT EXISTS (SELECT 1 FROM space_task_events AS completed
            WHERE completed.item_id = item.item_id AND completed.content_kind = 'result'
              AND completed.run_ref = candidate.chat_run_id)
          AND NOT COALESCE(run.status = 'completed' AND ${quietRunOutcome(sql, "run")}, 0)
          AND NOT EXISTS (SELECT 1 FROM tool_calls AS receipt
            WHERE receipt.run_id = candidate.chat_run_id
              AND receipt.tool_name IN ('space_task_update', 'task_update', 'task_wait')
              AND receipt.status = 'completed' AND json_extract(receipt.result_json, '$.is_error') = 0
              AND json_extract(receipt.arguments_json, '$.patch.completion_result') IS NULL
              AND json_extract(receipt.result_json, '$.content') = candidate.result)
        ORDER BY candidate.ended_at DESC, candidate.id DESC LIMIT 1
      )
    )
    SELECT json_set(latest.result, '$.unseen', json(CASE
      WHEN seen.result_key = json_extract(latest.result, '$.result_key') THEN 'false' ELSE 'true' END)) AS result
    FROM (
      SELECT item_id, result, ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY created_at DESC, priority DESC) AS position
      FROM candidates
    ) AS latest LEFT JOIN space_task_result_reads AS seen ON seen.item_id = latest.item_id
    WHERE latest.position = 1
  `.pipe(Effect.mapError((cause) => workError("storage", "Could not read Task results", cause)))
  return yield* Effect.forEach(rows, (row) =>
    decodeJson(SpaceTaskResultSchema, row.result).pipe(
      Effect.mapError((cause) => workError("storage", "Stored Task result is corrupt", cause))
    )
  )
})
