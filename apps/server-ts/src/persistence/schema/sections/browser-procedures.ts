import type { OperationalSchemaSection } from "../section.js"

export const browserProceduresSchemaSection = {
  name: "browser.procedures",
  storageDomain: "operations",
  tables: [
    "browser_procedure_settings",
    "browser_procedures",
    "browser_procedure_revisions",
    "browser_procedure_jobs",
    "browser_procedure_invocations"
  ],
  indexes: ["idx_browser_procedures_scope", "idx_browser_procedure_jobs_status"],
  triggers: ["browser_procedure_revision_immutable"],
  statements: [
    `CREATE TABLE browser_procedure_settings (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      since TEXT NOT NULL
    )`,
    `CREATE TABLE browser_procedures (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      profile_ref TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('candidate','accepted','suspended')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX idx_browser_procedures_scope ON browser_procedures(origin, profile_ref, status)`,
    `CREATE TABLE browser_procedure_revisions (
      procedure_id TEXT NOT NULL REFERENCES browser_procedures(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      specification_json TEXT NOT NULL CHECK(json_valid(specification_json)),
      evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY(procedure_id, revision)
    )`,
    `CREATE TRIGGER browser_procedure_revision_immutable BEFORE UPDATE ON browser_procedure_revisions
      BEGIN SELECT RAISE(ABORT, 'Browser procedure revisions are immutable'); END`,
    `CREATE TABLE browser_procedure_jobs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
      error TEXT,
      lease_token TEXT,
      lease_until INTEGER,
      retry_at INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX idx_browser_procedure_jobs_status ON browser_procedure_jobs(status, created_at)`,
    `CREATE TABLE browser_procedure_invocations (
      run_id TEXT NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE,
      tool_call_id TEXT NOT NULL,
      parent_tool_call_id TEXT NOT NULL,
      input_json TEXT NOT NULL CHECK(json_valid(input_json)),
      policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
      procedure_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      input_hash TEXT NOT NULL,
      tab_ref TEXT NOT NULL,
      read_only INTEGER NOT NULL DEFAULT 0 CHECK(read_only IN (0,1)),
      status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','uncertain','not_applicable')),
      created_at TEXT NOT NULL,
      ended_at TEXT,
      PRIMARY KEY(run_id,tool_call_id),
      UNIQUE(run_id,parent_tool_call_id),
      FOREIGN KEY(procedure_id,revision) REFERENCES browser_procedure_revisions(procedure_id,revision)
    )`,
    "INSERT INTO browser_procedure_settings VALUES (1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
  ]
} as const satisfies OperationalSchemaSection
