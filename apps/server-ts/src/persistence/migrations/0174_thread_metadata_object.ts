import type { Migration } from "./index.js"

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
