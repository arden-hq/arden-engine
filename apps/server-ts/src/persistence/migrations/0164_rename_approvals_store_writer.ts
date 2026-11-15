import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const LEGACY_OPEN =
  "Asked for before Arden kept who asked for a rename. If the page already has the new name, the rename was saved; otherwise ask for it again."

/** SQLite cannot add a CHECK in place, so the table is rebuilt with every row copied and its
 *  indexes made again. */
const up = (database: DatabaseSync): void => {
  database
    .prepare(
      `UPDATE wiki_rename_approvals SET status = 'rejected', resolution = ?
      WHERE status IN ('pending', 'applying')`
    )
    .run(LEGACY_OPEN)
  database.exec(`CREATE TABLE wiki_rename_approvals_next (
      approval_id TEXT PRIMARY KEY CHECK (length(approval_id) > 0),
      page_id TEXT NOT NULL CHECK (length(page_id) > 0),
      plan_json TEXT NOT NULL CHECK (json_valid(plan_json) AND json_type(plan_json) = 'object'),
      writer_json TEXT CHECK (writer_json IS NULL OR (json_valid(writer_json) AND json_type(writer_json) = 'object')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'applying', 'accepted', 'rejected')),
      created_at TEXT NOT NULL,
      commit_id TEXT,
      resolution TEXT,
      CHECK (
        (status IN ('pending', 'applying', 'rejected') AND commit_id IS NULL)
        OR (status = 'accepted' AND commit_id IS NOT NULL)
      ),
      CHECK (status IN ('accepted', 'rejected') OR writer_json IS NOT NULL)
    )`)
  const columns = "approval_id, page_id, plan_json, status, created_at, commit_id, resolution"
  database.exec(
    `INSERT INTO wiki_rename_approvals_next (${columns}) SELECT ${columns} FROM wiki_rename_approvals`
  )
  database.exec("DROP TABLE wiki_rename_approvals")
  database.exec("ALTER TABLE wiki_rename_approvals_next RENAME TO wiki_rename_approvals")
  database.exec(`CREATE UNIQUE INDEX idx_wiki_rename_approvals_open_page
      ON wiki_rename_approvals(page_id)
      WHERE status IN ('pending', 'applying')`)
  database.exec(`CREATE INDEX idx_wiki_rename_approvals_open_created
      ON wiki_rename_approvals(status, created_at)`)
}

export const renameApprovalsStoreWriter: Migration = {
  version: 164,
  name: "rename_approvals_store_writer",
  foreignKeys: { kind: "enforced" },
  up
}
