import type { Migration } from "./index.js"

export const proposalRetirement: Migration = {
  version: 57,
  name: "proposal_retirement",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`CREATE TABLE task_proposals_next (
      proposal_id TEXT PRIMARY KEY CHECK(length(proposal_id) > 0),
      place TEXT NOT NULL CHECK(place IN ('desk', 'chat', 'home')),
      desk_id TEXT REFERENCES desks(desk_id) ON DELETE CASCADE,
      chat_session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
      dedupe_key TEXT NOT NULL UNIQUE CHECK(length(dedupe_key) > 0),
      stable_key TEXT NOT NULL CHECK(length(stable_key) > 0),
      text TEXT NOT NULL CHECK(length(trim(text)) > 0),
      body TEXT,
      owner TEXT NOT NULL CHECK(owner IN ('worker', 'user', 'external')),
      capture_json TEXT NOT NULL CHECK(json_valid(capture_json)),
      sources_json TEXT NOT NULL CHECK(json_valid(sources_json) AND json_type(sources_json) = 'array'),
      signal_json TEXT CHECK(signal_json IS NULL OR (json_valid(signal_json) AND json_type(signal_json) = 'object')),
      evidence_revision_key TEXT NOT NULL CHECK(length(evidence_revision_key) > 0),
      candidate_hash TEXT NOT NULL CHECK(length(candidate_hash) > 0),
      source_run_id TEXT CHECK(source_run_id IS NULL OR length(source_run_id) > 0),
      source_session_id TEXT REFERENCES sessions(session_id),
      source_turn_id TEXT CHECK(source_turn_id IS NULL OR length(source_turn_id) > 0),
      source_tool_call_id TEXT CHECK(source_tool_call_id IS NULL OR length(source_tool_call_id) > 0),
      capture_policy_json TEXT CHECK(capture_policy_json IS NULL OR json_valid(capture_policy_json)),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      seq INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('held', 'offered', 'accepted', 'rejected', 'retired')),
      item_id TEXT REFERENCES desk_tasks(item_id) ON DELETE SET NULL,
      settlement_client_id TEXT,
      settlement_decision TEXT CHECK(settlement_decision IN ('accept', 'reject') OR settlement_decision IS NULL),
      settlement_task_json TEXT CHECK(settlement_task_json IS NULL OR json_valid(settlement_task_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT,
      retirement_json TEXT CHECK(retirement_json IS NULL OR (json_valid(retirement_json) AND json_type(retirement_json) = 'object')),
      CHECK((status = 'retired') = (retirement_json IS NOT NULL)),
      CHECK(status != 'retired' OR (settlement_client_id IS NULL AND settlement_decision IS NULL AND settled_at IS NOT NULL)),
      CHECK(updated_at >= created_at),
      CHECK((place = 'desk') = (desk_id IS NOT NULL)),
      CHECK((place = 'chat') = (chat_session_id IS NOT NULL)),
      CHECK((source_run_id IS NULL) = (source_session_id IS NULL)
        AND (source_run_id IS NULL) = (source_turn_id IS NULL)
        AND (source_run_id IS NULL) = (source_tool_call_id IS NULL)
        AND (source_run_id IS NULL) = (capture_policy_json IS NULL)),
      CHECK((status IN ('held', 'offered')) = (settlement_client_id IS NULL AND settlement_decision IS NULL AND settled_at IS NULL)),
      CHECK(status = 'accepted' OR (item_id IS NULL AND settlement_task_json IS NULL)),
      CHECK(status != 'accepted' OR settlement_decision = 'accept'),
      CHECK(status != 'rejected' OR settlement_decision = 'reject')
    )`)
    database.exec(`INSERT INTO task_proposals_next SELECT *, NULL FROM task_proposals`)
    database.exec("DROP TABLE task_proposals")
    database.exec("ALTER TABLE task_proposals_next RENAME TO task_proposals")
    database.exec(`CREATE INDEX idx_task_proposals_desk_status
      ON task_proposals(desk_id, status, updated_at DESC, proposal_id)`)
    database.exec(`CREATE INDEX idx_task_proposals_place_status
      ON task_proposals(place, status, seq)`)
    database.exec(`CREATE INDEX idx_task_proposals_chat_status
      ON task_proposals(chat_session_id, status)`)
  }
}
