import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** The owner's standing rules (`AGENTS.md`) keep every version, so a change can be listed and
 * undone. Each change appends a row with its writer and time; rows never change. The server
 * seeds the rules as they are at its first start, so the table starts empty. */
const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE global_instruction_versions (
      version INTEGER PRIMARY KEY CHECK(version > 0),
      content TEXT NOT NULL,
      digest TEXT NOT NULL CHECK(length(digest) > 0),
      writer TEXT NOT NULL CHECK(writer IN ('seed', 'outside', 'chat', 'restore')),
      session_id TEXT,
      run_id TEXT,
      restored_from INTEGER CHECK(restored_from IS NULL OR (restored_from > 0 AND restored_from < version)),
      recorded_at TEXT NOT NULL,
      CHECK((writer IN ('chat', 'restore')) = (session_id IS NOT NULL AND run_id IS NOT NULL)),
      CHECK((writer = 'restore') = (restored_from IS NOT NULL))
    )`)
  database.exec(`CREATE TRIGGER global_instruction_versions_immutable
      BEFORE UPDATE ON global_instruction_versions
      BEGIN SELECT RAISE(ABORT, 'Instruction versions are immutable'); END`)
  database.exec(`CREATE TRIGGER global_instruction_versions_kept
      BEFORE DELETE ON global_instruction_versions
      BEGIN SELECT RAISE(ABORT, 'Instruction versions are kept'); END`)
}

export const globalInstructionVersions: Migration = {
  version: 163,
  name: "global_instruction_versions",
  foreignKeys: { kind: "enforced" },
  up
}
