import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** The owner's standing rules (`AGENTS.md`) keep every version, so a change can be listed and
 * undone. Each change appends a row with its writer and time. A row's text never changes; it
 * loses its chat when that chat is deleted, and the whole row can be forgotten. Numbers are never
 * reused. The server seeds the rules as they are at its first start, so the table starts empty. */
const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE global_instruction_versions (
      version INTEGER PRIMARY KEY AUTOINCREMENT CHECK(version > 0),
      content TEXT NOT NULL,
      digest TEXT NOT NULL CHECK(length(digest) > 0),
      writer TEXT NOT NULL CHECK(writer IN ('seed', 'outside', 'chat', 'restore')),
      session_id TEXT,
      run_id TEXT,
      restored_from INTEGER CHECK(restored_from IS NULL OR (restored_from > 0 AND restored_from < version)),
      recorded_at TEXT NOT NULL,
      CHECK((session_id IS NULL) = (run_id IS NULL)),
      CHECK(writer IN ('chat', 'restore') OR session_id IS NULL),
      CHECK((writer = 'restore') = (restored_from IS NOT NULL))
    )`)
  database.exec(`CREATE TRIGGER global_instruction_versions_fixed
      BEFORE UPDATE OF version, content, digest, writer, restored_from, recorded_at
      ON global_instruction_versions
      BEGIN SELECT RAISE(ABORT, 'Instruction versions are immutable'); END`)
  database.exec(`CREATE TRIGGER global_instruction_versions_chat_cleared
      BEFORE UPDATE OF session_id, run_id ON global_instruction_versions
      WHEN NEW.session_id IS NOT NULL OR NEW.run_id IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'A version only loses its chat'); END`)
}

export const globalInstructionVersions: Migration = {
  version: 163,
  name: "global_instruction_versions",
  foreignKeys: { kind: "enforced" },
  up
}
