import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const APPROVAL_REVIEWS = `CREATE TABLE approval_reviews (
      run_id TEXT NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE CHECK(length(run_id) > 0),
      tool_call_id TEXT NOT NULL CHECK(length(tool_call_id) > 0),
      session_id TEXT NOT NULL CHECK(length(session_id) > 0),
      tool_name TEXT NOT NULL CHECK(length(tool_name) > 0),
      reviewed_at TEXT NOT NULL,
      rung TEXT NOT NULL CHECK(rung IN ('always_ask', 'standing', 'boundary', 'override', 'requirement', 'default')),
      model_id TEXT,
      decision TEXT NOT NULL CHECK(decision IN ('allow', 'ask')),
      decided_by TEXT NOT NULL CHECK(decided_by IN ('outcome', 'policy', 'timed_out', 'failed', 'stopped')),
      verdict TEXT CHECK(verdict IS NULL OR verdict IN ('allow', 'ask')),
      risk TEXT CHECK(risk IS NULL OR risk IN ('low', 'medium', 'high', 'critical')),
      user_authorization TEXT CHECK(user_authorization IS NULL OR user_authorization IN ('high', 'medium', 'low', 'unknown')),
      authorization_source TEXT CHECK(authorization_source IS NULL OR authorization_source IN ('owner', 'brief')),
      policy_category TEXT CHECK(policy_category IS NULL OR policy_category IN ('none', 'external_send', 'delete_data', 'spend')),
      narrowly_scoped INTEGER CHECK(narrowly_scoped IS NULL OR narrowly_scoped IN (0, 1)),
      malicious_prompt_injection INTEGER CHECK(malicious_prompt_injection IS NULL OR malicious_prompt_injection IN (0, 1)),
      abbreviated INTEGER CHECK(abbreviated IS NULL OR abbreviated IN (0, 1)),
      rationale TEXT,
      PRIMARY KEY (run_id, tool_call_id),
      CHECK((verdict IS NULL) = (decided_by IN ('timed_out', 'failed', 'stopped'))),
      CHECK((verdict IS NULL) = (risk IS NULL) AND (verdict IS NULL) = (user_authorization IS NULL)
        AND (verdict IS NULL) = (authorization_source IS NULL)
        AND (verdict IS NULL) = (policy_category IS NULL)),
      CHECK(decision = 'ask' OR decided_by = 'outcome')
    )`

const up = (database: DatabaseSync): void => {
  database.exec(APPROVAL_REVIEWS)
}

export const approvalReviews: Migration = {
  version: 65,
  name: "approval_reviews",
  foreignKeys: { kind: "enforced" },
  up
}
