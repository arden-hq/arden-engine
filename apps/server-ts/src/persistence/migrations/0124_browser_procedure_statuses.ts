import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const browserProcedures = `CREATE TABLE browser_procedures (
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
    )`

const browserProcedureInvocations = `CREATE TABLE browser_procedure_invocations (
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
    )`

const up = (database: DatabaseSync): void => {
  database.exec("PRAGMA legacy_alter_table = ON")
  try {
    database.exec("ALTER TABLE browser_procedures RENAME TO browser_procedures_prior")
    database.exec(
      "ALTER TABLE browser_procedure_invocations RENAME TO browser_procedure_invocations_prior"
    )
  } finally {
    database.exec("PRAGMA legacy_alter_table = OFF")
  }
  database.exec(browserProcedures)
  database.exec(`INSERT INTO browser_procedures (
      id, origin, profile_ref, name, description, status, enabled, revision,
      success_count, failure_count, updated_at
    ) SELECT id, origin, profile_ref, name, description,
      CASE status WHEN 'testing' THEN 'candidate' ELSE status END, enabled, revision,
      success_count, failure_count, updated_at
    FROM browser_procedures_prior`)
  database.exec("DROP TABLE browser_procedures_prior")
  database.exec(
    "CREATE INDEX idx_browser_procedures_scope ON browser_procedures(origin, profile_ref, status)"
  )
  database.exec(browserProcedureInvocations)
  database.exec(`INSERT INTO browser_procedure_invocations (
      run_id, tool_call_id, parent_tool_call_id, input_json, policy_json, procedure_id,
      revision, input_hash, tab_ref, read_only, status, created_at, ended_at
    ) SELECT run_id, tool_call_id, parent_tool_call_id, input_json, policy_json, procedure_id,
      revision, input_hash, tab_ref, read_only, status, created_at, ended_at
    FROM browser_procedure_invocations_prior`)
  database.exec("DROP TABLE browser_procedure_invocations_prior")
}

export const browserProcedureStatuses: Migration = {
  version: 124,
  name: "browser_procedure_statuses",
  foreignKeys: {
    kind: "rebuilds",
    tables: ["browser_procedures", "browser_procedure_invocations"]
  },
  up
}
