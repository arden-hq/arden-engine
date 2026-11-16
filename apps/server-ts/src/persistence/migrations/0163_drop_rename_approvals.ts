import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec("DROP TABLE wiki_rename_approvals")
}

export const dropRenameApprovals: Migration = {
  version: 163,
  name: "drop_rename_approvals",
  foreignKeys: { kind: "enforced" },
  up
}
