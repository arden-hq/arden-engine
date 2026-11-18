import type { Migration } from "./index.js"

/**
 * Migration 0036 took a chat's thread from a subquery. SQLite 3.54 hands a
 * subquery's JSON on as plain text (older SQLite kept it JSON), so on it the
 * thread was stored as a string of JSON, not an object. This turns such a
 * string back into the object. A thread that is already an object is left alone.
 */
export const threadMetadataObject: Migration = {
  version: 174,
  name: "thread_metadata_object",
  foreignKeys: { kind: "enforced" },
  up: (database) =>
    database.exec(
      `UPDATE sessions
       SET metadata = json_set(metadata, '$.thread', json(json_extract(metadata, '$.thread')))
       WHERE metadata LIKE '%"thread":"%'
         AND json_valid(metadata)
         AND json_type(metadata, '$.thread') = 'text'
         AND json_valid(json_extract(metadata, '$.thread'))
         AND json_type(json_extract(metadata, '$.thread')) = 'object'`
    )
}
