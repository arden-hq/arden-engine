import type { Migration } from "./index.js"

const statements = [
  "ALTER TABLE desk_summaries ADD COLUMN revision_id INTEGER",
  `CREATE TABLE desk_overview_revisions (
      revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
      desk_id TEXT NOT NULL REFERENCES desks(desk_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('baseline', 'generated')),
      now TEXT NOT NULL,
      next_json TEXT NOT NULL CHECK(json_valid(next_json) AND json_type(next_json) = 'array'),
      recent TEXT,
      sources_fingerprint TEXT NOT NULL,
      source_refs_json TEXT CHECK(source_refs_json IS NULL OR
        (json_valid(source_refs_json) AND json_type(source_refs_json) = 'array'
          AND json_array_length(source_refs_json) <= 12)),
      user_prompt TEXT CHECK(user_prompt IS NULL OR length(user_prompt) <= 100000),
      system_prompt_hash TEXT CHECK(system_prompt_hash IS NULL OR length(system_prompt_hash) = 64),
      trigger_automation_run_id INTEGER,
      trigger_chat_run_id TEXT,
      generated_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      CHECK((kind = 'baseline') = (user_prompt IS NULL)),
      CHECK(kind = 'baseline' OR
        (source_refs_json IS NOT NULL AND system_prompt_hash IS NOT NULL))
    )`,
  `CREATE INDEX idx_desk_overview_revisions_desk
      ON desk_overview_revisions(desk_id, revision_id)`,
  `CREATE TRIGGER desk_overview_revisions_immutable BEFORE UPDATE ON desk_overview_revisions
      BEGIN SELECT RAISE(ABORT, 'Desk overview revisions are immutable'); END`
]

export const deskOverviewHistory: Migration = {
  version: 89,
  name: "desk_overview_history",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    for (const statement of statements) database.exec(statement)
  }
}
