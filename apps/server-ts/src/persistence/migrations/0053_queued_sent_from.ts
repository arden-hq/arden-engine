import type { Migration } from "./index.js"

export const queuedSentFrom: Migration = {
  version: 53,
  name: "queued_sent_from",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(
      "ALTER TABLE session_queued_messages ADD COLUMN sent_from TEXT CHECK(sent_from IS NULL OR sent_from IN ('answer', 'visualization'))"
    )
  }
}
