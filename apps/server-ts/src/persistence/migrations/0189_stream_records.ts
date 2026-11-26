import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const PART_SUFFIX = /-(?:reasoning(?:-\d+)?|text-\d+)$/u

const recordOf = (rootId: string | undefined, messageId: string): string | undefined =>
  rootId !== undefined && (messageId === rootId || messageId.startsWith(`${rootId}-`))
    ? messageId.replace(PART_SUFFIX, "")
    : undefined

const up = (database: DatabaseSync): void => {
  const journal = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'journal_records'"
    )
    .get()
  if (journal === undefined) return
  const rows = database
    .prepare(
      `SELECT record.stream_id, record.sequence, json_extract(record.data_json, '$.message_id') AS message_id,
         run.assistant_message_id AS root_id
       FROM journal_records AS record
       LEFT JOIN chat_runs AS run ON run.run_id = COALESCE(
         json_extract(record.attributes_json, '$.runId'), json_extract(record.data_json, '$.run_id'))
       WHERE record.event_type IN ('TEXT_MESSAGE_START', 'REASONING_MESSAGE_START')
         AND json_valid(record.data_json) AND json_type(record.data_json, '$.record') IS NULL`
    )
    .all()
  const update = database.prepare(
    `UPDATE journal_records SET data_json = json_set(data_json, '$.record', json(?))
     WHERE stream_id = ? AND sequence = ?`
  )
  for (const row of rows) {
    const messageId = typeof row.message_id === "string" ? row.message_id : ""
    const recordId = recordOf(typeof row.root_id === "string" ? row.root_id : undefined, messageId)
    const record =
      recordId === undefined ? { kind: "unowned" } : { kind: "part", record_id: recordId }
    update.run(JSON.stringify(record), String(row.stream_id), Number(row.sequence))
  }
}

export const streamRecords: Migration = {
  version: 189,
  name: "stream_records",
  foreignKeys: { kind: "enforced" },
  up
}
