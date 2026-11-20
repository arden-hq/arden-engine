import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"
import { removeTranscriptRows } from "./message-removal.js"

export const toolResultsAsToolMessages: Migration = {
  version: 176,
  name: "tool_results_as_tool_messages",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE TEMP TABLE tool_result_rows AS
      WITH chats AS (SELECT DISTINCT session_id FROM session_messages)
      SELECT message.message_rowid FROM chats JOIN session_messages AS message
        ON message.session_id = chats.session_id
        AND message.client_id >= 'async-result:' AND message.client_id < 'async-result;'
        AND ${WRITTEN_BY_ARDEN}
      UNION ALL
      SELECT message.message_rowid FROM chats JOIN session_messages AS message
        ON message.session_id = chats.session_id
        AND message.client_id >= 'tool-media:' AND message.client_id < 'tool-media;'
        AND ${WRITTEN_BY_ARDEN}
      UNION ALL
      SELECT message.message_rowid FROM chats JOIN session_messages AS message
        ON message.session_id = chats.session_id
        AND message.message_id >= 'async-launch:' AND message.message_id < 'async-launch;'`)
    database.exec("CREATE INDEX temp.tool_result_rows_rowid ON tool_result_rows(message_rowid)")
    lateResultsAsToolMessages(database)
    launchPlaceholdersAsReceipts(database)
    database.exec(`UPDATE session_messages
      SET message_json = json_remove(message_json, '$.async_tool_launch.delivery')
      WHERE ${CANDIDATE} AND role = 'tool'
        AND json_type(message_json, '$.async_tool_launch.delivery') IS NOT NULL`)
    mediaIntoToolResults(database)
    database.exec("DROP TABLE temp.tool_result_rows")
  }
}

const CANDIDATE = "message_rowid IN (SELECT message_rowid FROM temp.tool_result_rows)"

const WRITTEN_BY_ARDEN =
  "message.role = 'user' AND json_extract(message.message_json, '$.is_meta') = 1"

const lateResultsAsToolMessages = (database: DatabaseSync): void => {
  const callId = `COALESCE(json_extract(message_json, '$.content[0].metadata.tool_call_id'),
    substr(client_id, length('async-result:') + 1))`
  database.exec(`UPDATE session_messages SET
      role = 'tool', client_id = NULL, author = NULL,
      message_json = json_set(json_remove(message_json, '$.is_meta', '$.client_id'),
        '$.role', 'tool',
        '$.tool_call_id', ${callId},
        '$.content', COALESCE(json_extract(message_json, '$.content[0].content'), ''))
    WHERE ${CANDIDATE} AND role = 'user'
      AND json_extract(message_json, '$.content[0].content_type') = 'async_tool_result'`)
}

const receipt = (callId: string): string =>
  `(json_object('status', 'running', 'tool_call_id', ${callId}, 'instruction',
    'The result will arrive in an internal completion message.') || '')`

const launchPlaceholdersAsReceipts = (database: DatabaseSync): void => {
  const callId = `json_extract(message_json, '$.async_tool_launch.call_id')`
  database.exec(`UPDATE session_messages SET
      role = 'tool', client_id = NULL, author = NULL,
      search_text = ${receipt(callId)},
      message_json = json_set(
        json_remove(message_json, '$.is_meta', '$.client_id', '$.async_tool_launch.delivery'),
        '$.role', 'tool',
        '$.tool_call_id', ${callId},
        '$.content', ${receipt(callId)})
    WHERE ${CANDIDATE} AND role = 'user'
      AND json_type(message_json, '$.async_tool_launch.call_id') = 'text'`)
}

const mediaIntoToolResults = (database: DatabaseSync): void => {
  database.exec(`CREATE TEMP TABLE tool_media AS
    SELECT media.session_id, media.seq,
      (SELECT result.message_rowid FROM session_messages AS result
        WHERE result.session_id = media.session_id AND result.seq < media.seq
          AND result.role = 'tool'
          AND json_extract(result.message_json, '$.tool_call_id') = media.call_id
          AND json_type(result.message_json, '$.async_tool_launch') IS NULL
        ORDER BY result.seq DESC LIMIT 1) AS result_rowid,
      (SELECT json_group_array(json(block.value)) FROM json_each(media.message_json, '$.content') AS block
        WHERE NOT (json_extract(block.value, '$.type') = 'context'
          AND json_extract(block.value, '$.content_type') = 'tool_result_media')) AS model_content
    FROM (SELECT session_id, seq, message_json,
        COALESCE(json_extract(message_json, '$.content[0].metadata.tool_call_id'),
          substr(client_id, length('tool-media:') + 1)) AS call_id
      FROM session_messages
      WHERE ${CANDIDATE} AND role = 'user'
        AND (json_extract(message_json, '$.content[0].content_type') = 'tool_result_media'
          OR client_id LIKE 'tool-media:%')) AS media`)
  database.exec("CREATE INDEX temp.tool_media_result ON tool_media(result_rowid)")
  const orphan = database
    .prepare("SELECT session_id, seq FROM tool_media WHERE result_rowid IS NULL LIMIT 1")
    .get()
  if (orphan !== undefined)
    throw new Error(
      `Tool media at ${String(orphan.session_id)}#${String(orphan.seq)} has no tool result to join`
    )
  database.exec(`UPDATE session_messages
    SET message_json = json_set(message_json, '$.model_content',
      json((SELECT model_content FROM tool_media WHERE result_rowid = session_messages.message_rowid)))
    WHERE message_rowid IN (SELECT result_rowid FROM tool_media)`)
  removeTranscriptRows(database, "SELECT session_id, seq FROM tool_media")
  database.exec("DROP TABLE temp.tool_media")
}
