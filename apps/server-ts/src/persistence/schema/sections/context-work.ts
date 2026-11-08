import type { OperationalSchemaSection } from "../section.js"

export const contextWorkSchemaSection = {
  name: "context.work",
  storageDomain: "work",
  tables: ["spaces"],
  indexes: [
    "idx_spaces_archived_updated",
    "idx_spaces_active_name_key",
    "idx_spaces_page_path",
    "idx_spaces_page_id"
  ],
  triggers: [],
  statements: [
    `CREATE TABLE spaces (
      space_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      instructions TEXT,
      instructions_source TEXT CHECK (instructions_source IN ('manual','generated') OR instructions_source IS NULL),
      page_path TEXT,
      page_id TEXT,
      inference_policy TEXT NOT NULL DEFAULT '{"enabled":false}' CHECK(json_valid(inference_policy)),
      policy_generation INTEGER NOT NULL DEFAULT 0 CHECK(policy_generation >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )`,
    "ALTER TABLE spaces ADD COLUMN pinned_position INTEGER CHECK(pinned_position IS NULL OR pinned_position >= 0)",
    "ALTER TABLE spaces ADD COLUMN mark TEXT CHECK(mark IS NULL OR json_valid(mark))",
    "CREATE INDEX idx_spaces_archived_updated ON spaces(archived_at, updated_at DESC)",
    "CREATE UNIQUE INDEX idx_spaces_active_name_key ON spaces(name_key) WHERE archived_at IS NULL",
    "CREATE UNIQUE INDEX idx_spaces_page_path ON spaces(page_path) WHERE page_path IS NOT NULL",
    "CREATE UNIQUE INDEX idx_spaces_page_id ON spaces(page_id) WHERE page_id IS NOT NULL"
  ]
} as const satisfies OperationalSchemaSection
