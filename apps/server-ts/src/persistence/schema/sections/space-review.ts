import type { OperationalSchemaSection } from "../section.js"

export const spaceReviewSchemaSection = {
  name: "space-review",
  storageDomain: "work",
  tables: ["space_review_checkpoints", "space_chat_links"],
  indexes: [],
  triggers: [],
  statements: [
    `CREATE TABLE space_review_checkpoints (
      space_id TEXT PRIMARY KEY REFERENCES spaces(space_id) ON DELETE CASCADE,
      reviewed_input TEXT NOT NULL CHECK(json_valid(reviewed_input)),
      run_id TEXT REFERENCES chat_runs(run_id) ON DELETE SET NULL,
      reviewed_at TEXT NOT NULL
    )`,
    `CREATE TABLE space_chat_links (
      space_id TEXT NOT NULL REFERENCES spaces(space_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL CHECK(length(run_id) > 0),
      linked_at TEXT NOT NULL,
      PRIMARY KEY (space_id, session_id)
    )`
  ]
} as const satisfies OperationalSchemaSection
