import type { Migration } from "./index.js"

export const scriptProgress: Migration = {
  version: 50,
  name: "script_progress",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`ALTER TABLE code_mode_scripts ADD COLUMN progress_json TEXT
      CHECK(progress_json IS NULL OR (json_valid(progress_json) AND json_type(progress_json) = 'object'))`)
  }
}
