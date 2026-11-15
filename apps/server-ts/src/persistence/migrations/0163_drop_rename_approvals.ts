import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** A rename is planned and saved like any other Memory change: the app previews it and sends the
 *  same request to save it, so no approval outlives the request. */
const up = (database: DatabaseSync): void => {
  database.exec("DROP TABLE wiki_rename_approvals")
}

export const dropRenameApprovals: Migration = {
  version: 163,
  name: "drop_rename_approvals",
  foreignKeys: { kind: "enforced" },
  up
}
