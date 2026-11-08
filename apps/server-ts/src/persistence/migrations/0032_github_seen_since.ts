import type { Migration } from "./index.js"

export const githubSeenSince: Migration = {
  version: 32,
  name: "github_seen_since",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec("ALTER TABLE connection_cursors ADD COLUMN since TEXT")
  }
}
