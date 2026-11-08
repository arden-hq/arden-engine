import type { Migration } from "./index.js"

export const toolCallEffect: Migration = {
  version: 15,
  name: "tool_call_effect",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(
      "ALTER TABLE tool_calls ADD COLUMN effect TEXT CHECK(effect IS NULL OR effect IN ('none', 'run_record', 'arden_db', 'local_files', 'external'))"
    )
  }
}
