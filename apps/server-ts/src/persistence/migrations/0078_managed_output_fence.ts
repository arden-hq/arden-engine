import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(
    "ALTER TABLE managed_output_lifecycle_lock RENAME TO managed_output_lifecycle_lock_old"
  )
  database.exec(`CREATE TABLE managed_output_lifecycle_lock (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      generation INTEGER NOT NULL CHECK(generation >= 0),
      holder_pid INTEGER CHECK(holder_pid IS NULL OR holder_pid > 0),
      holder_token TEXT CHECK(
        (holder_pid IS NULL AND holder_token IS NULL) OR
        (holder_pid IS NOT NULL AND holder_token IS NOT NULL AND length(holder_token) > 0)
      )
    )`)
  database.exec(`INSERT INTO managed_output_lifecycle_lock (singleton_id, generation)
    SELECT singleton_id, generation FROM managed_output_lifecycle_lock_old`)
  database.exec("DROP TABLE managed_output_lifecycle_lock_old")
  database.exec(`CREATE TRIGGER session_file_cleanup_no_recreate
      BEFORE INSERT ON sessions
      WHEN EXISTS (SELECT 1 FROM session_file_cleanup WHERE session_id = new.session_id)
      BEGIN
        SELECT RAISE(ABORT, 'Session file cleanup is pending');
      END`)
}

export const managedOutputFence: Migration = {
  version: 78,
  name: "managed_output_fence",
  foreignKeys: { kind: "enforced" },
  up
}
