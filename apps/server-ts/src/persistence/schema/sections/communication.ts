import type { OperationalSchemaSection } from "../section.js"
import { ENTITY_EVENTS_RUN_INDEX, ENTITY_EVENTS_TABLE } from "../../migrations/0183_main_space.js"

/** SQLite splices this column's text into the stored `automation_deliveries` DDL,
 *  so the schema and the communication conversion share one spelling. */
export const communicationSequenceColumnSql = `ALTER TABLE automation_deliveries ADD COLUMN
      communication_sequence INTEGER CHECK(
        communication_sequence IS NULL OR communication_sequence > 0
      )`

export const communicationSchemaSection = {
  name: "communication",
  storageDomain: "work",
  tables: [
    "communication_sequence_clock",
    "space_continuity_seen",
    "run_endings",
    "entity_events",
    "run_tells"
  ],
  indexes: [
    "idx_automation_deliveries_communication_sequence",
    "idx_automation_deliveries_communication_space",
    "idx_entity_events_run",
    "idx_run_endings_undecided",
    "idx_automation_deliveries_answer",
    "idx_run_endings_status_at"
  ],
  triggers: [],
  statements: [
    communicationSequenceColumnSql,
    `CREATE UNIQUE INDEX idx_automation_deliveries_communication_sequence
      ON automation_deliveries(communication_sequence)
      WHERE communication_sequence IS NOT NULL`,
    `CREATE INDEX idx_automation_deliveries_communication_space
      ON automation_deliveries(
        json_extract(payload, '$.destinationSpaceId'), communication_sequence
      )
      WHERE json_extract(payload, '$.kind') = 'communication'`,
    `CREATE TABLE communication_sequence_clock (
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
      current_sequence INTEGER NOT NULL CHECK(current_sequence >= 0)
    )`,
    "INSERT INTO communication_sequence_clock(singleton_id, current_sequence) VALUES(1, 0)",
    `CREATE TABLE space_continuity_seen (
      space_id TEXT PRIMARY KEY REFERENCES spaces(space_id) ON DELETE CASCADE,
      state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version >= 0),
      arrivals_through INTEGER NOT NULL DEFAULT 0 CHECK(arrivals_through >= 0),
      task_events_through INTEGER NOT NULL DEFAULT 0 CHECK(task_events_through >= 0),
      question_changes_through INTEGER NOT NULL DEFAULT 0 CHECK(question_changes_through >= 0),
      last_acknowledgement_hash TEXT CHECK(
        last_acknowledgement_hash IS NULL OR (
          length(last_acknowledgement_hash) = 64 AND
          last_acknowledgement_hash NOT GLOB '*[^0-9a-f]*'
        )
      ),
      acknowledged_at TEXT
    )`,
    `CREATE TABLE run_endings (
      run_id TEXT PRIMARY KEY REFERENCES chat_runs(run_id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK(purpose IN ('chat', 'user_automation', 'system', 'task_execution', 'space_review')),
      status TEXT NOT NULL CHECK(status IN ('finished', 'blocked', 'failed', 'cancelled', 'silent', 'waiting')),
      detail TEXT,
      text TEXT NOT NULL,
      place TEXT,
      place_kind TEXT NOT NULL CHECK(place_kind IN ('own', 'chat', 'parent', 'sender', 'gone')),
      occurred_at TEXT NOT NULL,
      shown INTEGER NOT NULL CHECK(shown IN (0, 1)),
      decided INTEGER NOT NULL CHECK(decided IN (0, 1)),
      delivery_error TEXT
    )`,
    ENTITY_EVENTS_TABLE,
    `CREATE TABLE run_tells (
      run_id TEXT NOT NULL REFERENCES chat_runs(run_id) ON DELETE CASCADE,
      n INTEGER NOT NULL CHECK(n >= 1),
      tool_call_id TEXT NOT NULL,
      text TEXT NOT NULL,
      place TEXT,
      place_kind TEXT NOT NULL CHECK(place_kind IN ('chat', 'parent')),
      occurred_at TEXT NOT NULL,
      shown INTEGER NOT NULL CHECK(shown IN (0, 1)),
      delivery_error TEXT,
      PRIMARY KEY (run_id, n),
      UNIQUE (run_id, tool_call_id)
    )`,
    ENTITY_EVENTS_RUN_INDEX,
    `CREATE INDEX idx_run_endings_undecided ON run_endings(run_id) WHERE decided = 0`,
    `CREATE INDEX idx_automation_deliveries_answer
      ON automation_deliveries(destinations) WHERE json_extract(payload, '$.kind') = 'answer'`,
    `CREATE INDEX idx_run_endings_status_at
      ON run_endings(status, decided, julianday(occurred_at))`
  ]
} as const satisfies OperationalSchemaSection
