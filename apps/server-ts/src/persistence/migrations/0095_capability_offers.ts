import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE capability_offers (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      tool_call_id TEXT NOT NULL CHECK(length(tool_call_id) > 0),
      run_id TEXT NOT NULL CHECK(length(run_id) > 0),
      candidates_json TEXT NOT NULL
        CHECK(json_valid(candidates_json) AND json_type(candidates_json) = 'array'),
      offered_at TEXT NOT NULL,
      outcome TEXT CHECK(outcome IS NULL OR outcome IN ('connected', 'declined', 'expired')),
      outcome_at TEXT,
      PRIMARY KEY (session_id, tool_call_id),
      CHECK((outcome IS NULL) = (outcome_at IS NULL))
    )`)
  database.exec(
    "CREATE INDEX idx_capability_offers_open ON capability_offers(offered_at) WHERE outcome IS NULL"
  )
}

export const capabilityOffers: Migration = {
  version: 95,
  name: "capability_offers",
  foreignKeys: { kind: "enforced" },
  up
}
