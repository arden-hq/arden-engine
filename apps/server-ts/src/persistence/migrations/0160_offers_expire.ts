import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/** `task_proposals.status` gains `expired`: an offer nobody answered in time. It is settled like a
 * retirement, with no settlement decision. Two columns hold an open offer's expiry clock:
 * `put_off_until`, set by the owner's Later, and `waiting_since`, the first time the owner was
 * around after it was last offered, revised or put off. SQLite cannot change a CHECK in place, so
 * the table is rebuilt with every row copied unchanged and both clocks empty, and its indexes and
 * history triggers are made again. No row changes status here, and no open offer has started
 * waiting: the sweep starts each clock when the owner is next around. */
const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE task_proposals_next (
      proposal_id TEXT PRIMARY KEY CHECK(length(proposal_id) > 0),
      place TEXT NOT NULL CHECK(place IN ('space', 'chat', 'home')),
      space_id TEXT REFERENCES spaces(space_id) ON DELETE CASCADE,
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
      status TEXT NOT NULL CHECK(status IN ('held', 'offered', 'accepted', 'rejected', 'expired', 'retired')),
      item_id TEXT REFERENCES space_tasks(item_id) ON DELETE SET NULL,
      settlement_client_id TEXT,
      settlement_decision TEXT CHECK(settlement_decision IN ('accept', 'reject') OR settlement_decision IS NULL),
      settlement_task_json TEXT CHECK(settlement_task_json IS NULL OR json_valid(settlement_task_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT,
      retirement_json TEXT CHECK(retirement_json IS NULL OR (json_valid(retirement_json) AND json_type(retirement_json) = 'object')),
      put_off_until TEXT,
      waiting_since TEXT,
      CHECK((status = 'retired') = (retirement_json IS NOT NULL)),
      CHECK(status != 'retired' OR (settlement_client_id IS NULL AND settlement_decision IS NULL AND settled_at IS NOT NULL)),
      CHECK(status != 'expired' OR (settlement_client_id IS NULL AND settlement_decision IS NULL AND settled_at IS NOT NULL)),
      CHECK(updated_at >= created_at),
      CHECK((place = 'space') = (space_id IS NOT NULL)),
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
  const columns = `proposal_id, place, space_id, chat_session_id, dedupe_key, stable_key, text, body, owner, capture_json, sources_json, signal_json, evidence_revision_key, candidate_hash, source_run_id, source_session_id, source_turn_id, source_tool_call_id, capture_policy_json, revision, seq, status, item_id, settlement_client_id, settlement_decision, settlement_task_json, created_at, updated_at, settled_at, retirement_json`
  database.exec(
    `INSERT INTO task_proposals_next (${columns}) SELECT ${columns} FROM task_proposals`
  )
  database.exec("DROP TABLE task_proposals")
  database.exec("ALTER TABLE task_proposals_next RENAME TO task_proposals")
  database.exec(`CREATE INDEX idx_task_proposals_space_status
      ON task_proposals(space_id, status, updated_at DESC, proposal_id)`)
  database.exec(`CREATE INDEX idx_task_proposals_place_status
      ON task_proposals(place, status, seq)`)
  database.exec(`CREATE INDEX idx_task_proposals_chat_status
      ON task_proposals(chat_session_id, status)`)
  database.exec("CREATE INDEX idx_task_proposals_item_id ON task_proposals(item_id)")
  database.exec(
    "CREATE INDEX idx_task_proposals_source_session_id ON task_proposals(source_session_id)"
  )
  database.exec(`CREATE TRIGGER task_proposal_revisions_insert AFTER INSERT ON task_proposals
      BEGIN
        INSERT INTO task_proposal_revisions (proposal_id, version, kind, state_json, recorded_at) SELECT NEW.proposal_id, COALESCE((SELECT MAX(version) FROM task_proposal_revisions WHERE proposal_id = NEW.proposal_id), 0) + 1, 'created', json_object('place', NEW.place, 'space_id', NEW.space_id, 'chat_session_id', NEW.chat_session_id, 'stable_key', NEW.stable_key, 'text', NEW.text, 'body', NEW.body, 'owner', NEW.owner, 'capture_json', NEW.capture_json, 'sources_json', NEW.sources_json, 'signal_json', NEW.signal_json, 'evidence_revision_key', NEW.evidence_revision_key, 'candidate_hash', NEW.candidate_hash, 'source_run_id', NEW.source_run_id, 'source_session_id', NEW.source_session_id, 'source_turn_id', NEW.source_turn_id, 'source_tool_call_id', NEW.source_tool_call_id, 'capture_policy_json', NEW.capture_policy_json, 'revision', NEW.revision, 'status', NEW.status, 'item_id', NEW.item_id, 'settlement_client_id', NEW.settlement_client_id, 'settlement_decision', NEW.settlement_decision, 'settlement_task_json', NEW.settlement_task_json, 'settled_at', NEW.settled_at, 'retirement_json', NEW.retirement_json), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ;
      END`)
  database.exec(`CREATE TRIGGER task_proposal_revisions_update BEFORE UPDATE OF place, space_id, chat_session_id, stable_key, text, body, owner, capture_json, sources_json, signal_json, evidence_revision_key, candidate_hash, source_run_id, source_session_id, source_turn_id, source_tool_call_id, capture_policy_json, revision, status, item_id, settlement_client_id, settlement_decision, settlement_task_json, settled_at, retirement_json ON task_proposals
      WHEN NEW.place IS NOT OLD.place OR NEW.space_id IS NOT OLD.space_id OR NEW.chat_session_id IS NOT OLD.chat_session_id OR NEW.stable_key IS NOT OLD.stable_key OR NEW.text IS NOT OLD.text OR NEW.body IS NOT OLD.body OR NEW.owner IS NOT OLD.owner OR NEW.capture_json IS NOT OLD.capture_json OR NEW.sources_json IS NOT OLD.sources_json OR NEW.signal_json IS NOT OLD.signal_json OR NEW.evidence_revision_key IS NOT OLD.evidence_revision_key OR NEW.candidate_hash IS NOT OLD.candidate_hash OR NEW.source_run_id IS NOT OLD.source_run_id OR NEW.source_session_id IS NOT OLD.source_session_id OR NEW.source_turn_id IS NOT OLD.source_turn_id OR NEW.source_tool_call_id IS NOT OLD.source_tool_call_id OR NEW.capture_policy_json IS NOT OLD.capture_policy_json OR NEW.revision IS NOT OLD.revision OR NEW.status IS NOT OLD.status OR NEW.item_id IS NOT OLD.item_id OR NEW.settlement_client_id IS NOT OLD.settlement_client_id OR NEW.settlement_decision IS NOT OLD.settlement_decision OR NEW.settlement_task_json IS NOT OLD.settlement_task_json OR NEW.settled_at IS NOT OLD.settled_at OR NEW.retirement_json IS NOT OLD.retirement_json
      BEGIN
        INSERT INTO task_proposal_revisions (proposal_id, version, kind, state_json, recorded_at) SELECT OLD.proposal_id, COALESCE((SELECT MAX(version) FROM task_proposal_revisions WHERE proposal_id = OLD.proposal_id), 0) + 1, 'baseline', json_object('place', OLD.place, 'space_id', OLD.space_id, 'chat_session_id', OLD.chat_session_id, 'stable_key', OLD.stable_key, 'text', OLD.text, 'body', OLD.body, 'owner', OLD.owner, 'capture_json', OLD.capture_json, 'sources_json', OLD.sources_json, 'signal_json', OLD.signal_json, 'evidence_revision_key', OLD.evidence_revision_key, 'candidate_hash', OLD.candidate_hash, 'source_run_id', OLD.source_run_id, 'source_session_id', OLD.source_session_id, 'source_turn_id', OLD.source_turn_id, 'source_tool_call_id', OLD.source_tool_call_id, 'capture_policy_json', OLD.capture_policy_json, 'revision', OLD.revision, 'status', OLD.status, 'item_id', OLD.item_id, 'settlement_client_id', OLD.settlement_client_id, 'settlement_decision', OLD.settlement_decision, 'settlement_task_json', OLD.settlement_task_json, 'settled_at', OLD.settled_at, 'retirement_json', OLD.retirement_json), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE NOT EXISTS (SELECT 1 FROM task_proposal_revisions WHERE proposal_id = OLD.proposal_id);
        INSERT INTO task_proposal_revisions (proposal_id, version, kind, state_json, recorded_at) SELECT NEW.proposal_id, COALESCE((SELECT MAX(version) FROM task_proposal_revisions WHERE proposal_id = NEW.proposal_id), 0) + 1, 'changed', json_object('place', NEW.place, 'space_id', NEW.space_id, 'chat_session_id', NEW.chat_session_id, 'stable_key', NEW.stable_key, 'text', NEW.text, 'body', NEW.body, 'owner', NEW.owner, 'capture_json', NEW.capture_json, 'sources_json', NEW.sources_json, 'signal_json', NEW.signal_json, 'evidence_revision_key', NEW.evidence_revision_key, 'candidate_hash', NEW.candidate_hash, 'source_run_id', NEW.source_run_id, 'source_session_id', NEW.source_session_id, 'source_turn_id', NEW.source_turn_id, 'source_tool_call_id', NEW.source_tool_call_id, 'capture_policy_json', NEW.capture_policy_json, 'revision', NEW.revision, 'status', NEW.status, 'item_id', NEW.item_id, 'settlement_client_id', NEW.settlement_client_id, 'settlement_decision', NEW.settlement_decision, 'settlement_task_json', NEW.settlement_task_json, 'settled_at', NEW.settled_at, 'retirement_json', NEW.retirement_json), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ;
      END`)
}

export const offersExpire: Migration = {
  version: 160,
  name: "offers_expire",
  foreignKeys: { kind: "rebuilds", tables: ["task_proposals"] },
  up
}
