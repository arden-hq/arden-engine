import type { OperationalSchemaSection } from "../section.js"

export const taskContractSchemaSection = {
  name: "task-contract",
  storageDomain: "work",
  tables: ["task_contract_lines", "task_contract_proposals"],
  indexes: ["idx_task_contract_lines_item", "idx_task_contract_proposals_open"],
  triggers: [],
  statements: [
    `CREATE TABLE task_contract_lines (
      line_id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL REFERENCES space_tasks(item_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('rule', 'criterion', 'decision')),
      text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 2000),
      rejected TEXT CHECK(rejected IS NULL OR (kind = 'decision' AND length(rejected) BETWEEN 1 AND 2000)),
      source_message_id TEXT NOT NULL CHECK(length(source_message_id) > 0),
      evidence_json TEXT CHECK(evidence_json IS NULL OR (kind = 'criterion'
        AND json_valid(evidence_json) AND json_type(evidence_json) = 'array')),
      created_at TEXT NOT NULL,
      retired_at TEXT
    )`,
    `CREATE INDEX idx_task_contract_lines_item
      ON task_contract_lines(item_id, line_id) WHERE retired_at IS NULL`,
    `CREATE TABLE task_contract_proposals (
      question_id TEXT PRIMARY KEY CHECK(length(question_id) > 0),
      item_id TEXT NOT NULL REFERENCES space_tasks(item_id) ON DELETE CASCADE,
      change_json TEXT NOT NULL CHECK(json_valid(change_json)
        AND json_extract(change_json, '$.kind') IN ('add', 'retire')),
      source_message_id TEXT NOT NULL CHECK(length(source_message_id) > 0),
      decision TEXT CHECK(decision IS NULL OR decision IN ('confirmed', 'dismissed')),
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX idx_task_contract_proposals_open
      ON task_contract_proposals(item_id) WHERE decision IS NULL`
  ]
} as const satisfies OperationalSchemaSection
