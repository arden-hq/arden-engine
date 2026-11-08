import type { Migration } from "./index.js"

export const oneProposalTable: Migration = {
  version: 48,
  name: "one_proposal_table",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(TASK_PROPOSALS)
    database.exec(`INSERT INTO task_proposals (proposal_id, place, desk_id, chat_session_id,
        dedupe_key, stable_key, text, body, owner, capture_json, sources_json, signal_json,
        evidence_revision_key, candidate_hash, source_run_id, source_session_id, source_turn_id,
        source_tool_call_id, capture_policy_json, revision, seq, status, item_id,
        settlement_client_id, settlement_decision, settlement_task_json, created_at, updated_at,
        settled_at)
      SELECT proposal.proposal_id, 'desk', proposal.desk_id, NULL, proposal.dedupe_key,
        proposal.stable_key, proposal.text, proposal.body, proposal.owner, proposal.capture_json,
        proposal.sources_json,
        (SELECT json_object('source', item.source, 'account', item.account,
            'thread_key', item.thread_key, 'title', item.title, 'from', item.sender)
          FROM json_each(proposal.sources_json) AS cited
          JOIN connection_items AS item ON item.item_id = json_extract(cited.value, '$.item_id')
          WHERE json_extract(cited.value, '$.kind') = 'connection_item'
          ORDER BY cited.key LIMIT 1),
        proposal.evidence_revision_key, proposal.candidate_hash, proposal.source_run_id,
        proposal.source_session_id, proposal.source_turn_id, proposal.source_tool_call_id,
        proposal.capture_policy_json, proposal.revision, 0, proposal.status, proposal.item_id,
        proposal.settlement_client_id, proposal.settlement_decision, proposal.settlement_task_json,
        proposal.created_at, proposal.updated_at, proposal.settled_at
      FROM desk_task_proposals AS proposal`)
    database.exec(`INSERT INTO task_proposals (proposal_id, place, desk_id, chat_session_id,
        dedupe_key, stable_key, text, body, owner, capture_json, sources_json, signal_json,
        evidence_revision_key, candidate_hash, source_run_id, source_session_id, source_turn_id,
        source_tool_call_id, capture_policy_json, revision, seq, status, item_id,
        settlement_client_id, settlement_decision, settlement_task_json, created_at, updated_at,
        settled_at)
      SELECT offer.offer_id, 'home', NULL, NULL, 'home:' || offer.offer_id,
        substr('offer-' || lower(substr(offer.offer_id, 7)), 1, 80), offer.text, NULL, 'worker',
        json_object('basis', 'inferred', 'reason', CASE WHEN length(trim(offer.why)) > 0
          THEN trim(offer.why) ELSE 'It came in from ' || CASE offer.source WHEN 'gmail' THEN 'Gmail'
          WHEN 'github' THEN 'GitHub' ELSE offer.source END || '.' END),
        CASE WHEN offer.item_id IS NULL THEN '[]' ELSE json_array(json_object(
          'kind', 'connection_item', 'item_id', offer.item_id, 'revision', offer.item_id)) END,
        json_object('source', offer.source, 'account', offer.account,
          'thread_key', offer.thread_key, 'title', offer.item_title, 'from', offer.item_from),
        'home:' || offer.offer_id, 'home:' || offer.offer_id, NULL, NULL, NULL, NULL, NULL,
        offer.revision, offer.seq, offer.status,
        CASE WHEN offer.status = 'accepted' THEN offer.task_item_id END,
        offer.settlement_client_id, offer.settlement_decision, NULL,
        offer.created_at, offer.updated_at, offer.settled_at
      FROM home_offers AS offer`)
    database.exec(`WITH ordered AS (SELECT proposal_id,
        ROW_NUMBER() OVER (ORDER BY created_at, seq, proposal_id) AS position FROM task_proposals)
      UPDATE task_proposals SET seq = ordered.position FROM ordered
      WHERE ordered.proposal_id = task_proposals.proposal_id`)
    database.exec("DROP TABLE desk_task_proposals")
    database.exec("DROP TABLE home_offers")
    for (const statement of INDEXES) database.exec(statement)
  }
}

const TASK_PROPOSALS = `CREATE TABLE task_proposals (
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
      status TEXT NOT NULL CHECK(status IN ('held', 'offered', 'accepted', 'rejected')),
      item_id TEXT REFERENCES desk_tasks(item_id) ON DELETE SET NULL,
      settlement_client_id TEXT,
      settlement_decision TEXT CHECK(settlement_decision IN ('accept', 'reject') OR settlement_decision IS NULL),
      settlement_task_json TEXT CHECK(settlement_task_json IS NULL OR json_valid(settlement_task_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT,
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
    )`

const INDEXES = [
  `CREATE INDEX idx_task_proposals_desk_status
      ON task_proposals(desk_id, status, updated_at DESC, proposal_id)`,
  `CREATE INDEX idx_task_proposals_place_status
      ON task_proposals(place, status, seq)`,
  `CREATE INDEX idx_task_proposals_chat_status
      ON task_proposals(chat_session_id, status)`
]
