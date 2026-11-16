import type { Migration } from "./index.js"

export const messageAuthors: Migration = {
  version: 165,
  name: "message_authors",
  foreignKeys: { kind: "enforced" },
  up: (database) => database.exec("ALTER TABLE session_messages ADD COLUMN author TEXT")
}
