import type { OperationalSchemaSection } from "../section.js"

export const storageSettingsSchemaSection = {
  name: "storage-settings",
  storageDomain: "configuration",
  tables: ["storage_settings", "storage_retention"],
  indexes: [],
  triggers: [],
  statements: [
    `CREATE TABLE storage_retention (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      agent_trace_days INTEGER CHECK(agent_trace_days IS NULL OR agent_trace_days BETWEEN 1 AND 3650),
      wiki_history_days INTEGER CHECK(wiki_history_days IS NULL OR wiki_history_days BETWEEN 1 AND 3650)
    )`,
    `CREATE TABLE storage_settings (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      max_space_gib REAL CHECK(max_space_gib IS NULL OR max_space_gib BETWEEN 0.1 AND 1000000),
      allow_archived_session_deletion INTEGER NOT NULL DEFAULT 0
        CHECK(allow_archived_session_deletion IN (0, 1)),
      allow_inactive_session_deletion INTEGER NOT NULL DEFAULT 0
        CHECK(allow_inactive_session_deletion IN (0, 1)),
      inactive_session_days INTEGER NOT NULL DEFAULT 90
        CHECK(inactive_session_days BETWEEN 1 AND 3650),
      minimum_current_sessions INTEGER NOT NULL DEFAULT 100
        CHECK(minimum_current_sessions BETWEEN 1 AND 100000)
    )`,
    `INSERT INTO storage_settings (
      singleton_id, max_space_gib,
      allow_archived_session_deletion, allow_inactive_session_deletion,
      inactive_session_days, minimum_current_sessions
    ) VALUES (1, NULL, 0, 0, 90, 100)`
  ]
} as const satisfies OperationalSchemaSection
