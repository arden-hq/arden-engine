import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`UPDATE automation_deliveries
    SET payload = json_set(payload, '$.visible', json('false'))
    WHERE subject = 'needs_you' AND json_extract(payload, '$.kind') = 'communication'`)
}

export const legacyNeedsYouHidden: Migration = {
  version: 72,
  name: "legacy_needs_you_hidden",
  foreignKeys: { kind: "enforced" },
  up
}
