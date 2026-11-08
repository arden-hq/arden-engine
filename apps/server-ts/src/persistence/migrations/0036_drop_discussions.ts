import type { Migration } from "./index.js"

export const dropDiscussions: Migration = {
  version: 36,
  name: "drop_discussions",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`UPDATE sessions SET metadata = json_set(COALESCE(metadata, '{}'), '$.thread', (
        SELECT CASE WHEN source.public_ref IS NULL THEN brief.thread
          ELSE json_set(brief.thread, '$.source_session_ref', source.public_ref) END
        FROM (SELECT json_object(
            'source_session_id', discussion.source_session_id,
            'source_turn_id', discussion.source_turn_id,
            'purpose', discussion.purpose,
            'starts_with', json(CASE WHEN json_type(discussion.context_json) = 'array'
              THEN discussion.context_json ELSE '[]' END)
          ) AS thread, discussion.source_session_id
          FROM session_discussions AS discussion
          WHERE discussion.session_id = sessions.session_id) AS brief
        LEFT JOIN sessions AS source ON source.session_id = brief.source_session_id))
      WHERE session_id IN (SELECT session_id FROM session_discussions)
        AND CASE WHEN json_valid(COALESCE(metadata, '{}'))
          THEN json_type(COALESCE(metadata, '{}'), '$.thread') IS NULL ELSE 0 END`)
    database.exec(`UPDATE sessions SET metadata = json_remove(metadata, '$.discussion_context')
      WHERE session_id IN (SELECT session_id FROM session_discussions)
        AND CASE WHEN json_valid(metadata)
          THEN json_type(metadata, '$.discussion_context') IS NOT NULL ELSE 0 END`)
    database.exec(`UPDATE automation_deliveries SET status = 'discarded'
      WHERE status = 'pending' AND json_extract(payload, '$.kind') = 'discussion_finding'`)
    database.exec("DROP TABLE session_discussions")
    database.exec("DROP TABLE discussion_offers")
  }
}
