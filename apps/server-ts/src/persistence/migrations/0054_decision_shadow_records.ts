import type { Migration } from "./index.js"

export const decisionShadowRecords: Migration = {
  version: 54,
  name: "decision_shadow_records",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE TABLE decision_shadow_records (
      record_id INTEGER PRIMARY KEY,
      site TEXT NOT NULL CHECK(length(site) BETWEEN 1 AND 64),
      subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 256),
      asked_at TEXT NOT NULL,
      backend TEXT NOT NULL CHECK(length(backend) BETWEEN 1 AND 64),
      model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 512),
      helper_answer_json TEXT NOT NULL CHECK(json_valid(helper_answer_json) AND json_type(helper_answer_json) = 'object'),
      decision_answer_json TEXT CHECK(decision_answer_json IS NULL OR (json_valid(decision_answer_json) AND json_type(decision_answer_json) = 'object')),
      probabilities_json TEXT CHECK(probabilities_json IS NULL OR (json_valid(probabilities_json) AND json_type(probabilities_json) = 'object')),
      error_reason TEXT CHECK(error_reason IS NULL OR length(error_reason) BETWEEN 1 AND 64),
      error_message TEXT,
      agree INTEGER CHECK(agree IS NULL OR agree IN (0, 1)),
      latency_ms INTEGER NOT NULL CHECK(latency_ms >= 0),
      CHECK((decision_answer_json IS NULL) = (error_reason IS NOT NULL)),
      CHECK((decision_answer_json IS NULL) = (agree IS NULL)),
      CHECK((decision_answer_json IS NULL) = (probabilities_json IS NULL))
    )`)
    database.exec(`CREATE INDEX idx_decision_shadow_records_site_model
      ON decision_shadow_records(site, model, agree)`)
  }
}
