import type { OperationalSchemaSection } from "../section.js"

export const contextModelSchemaSection = {
  name: "context.model",
  storageDomain: "model_context",
  tables: ["run_sidecars", "chat_compactions"],
  indexes: ["idx_chat_compactions_session_boundary"],
  triggers: [],
  statements: [
    `CREATE TABLE run_sidecars (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      context_manifest_json TEXT NOT NULL DEFAULT '[]',
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE chat_compactions (
      compaction_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      boundary_seq INTEGER NOT NULL,
      messages_before INTEGER NOT NULL,
      messages_after INTEGER NOT NULL,
      rehydration_state TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, compaction_id)
    )`,
    "CREATE INDEX idx_chat_compactions_session_boundary ON chat_compactions(session_id, boundary_seq)"
  ]
} as const satisfies OperationalSchemaSection
