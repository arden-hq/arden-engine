import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`DROP TRIGGER sessions_legacy_context_revision;
    DROP TABLE session_context_stage;
    DELETE FROM data_backfills WHERE name = 'active_context_window_staged';
    CREATE TEMP TABLE context_array (
      session_id TEXT PRIMARY KEY,
      messages TEXT
    ) WITHOUT ROWID;
    INSERT INTO context_array (session_id, messages)
      SELECT session_id, messages FROM sessions
      WHERE context_from_seq IS NULL
        AND CASE WHEN messages IS NULL THEN active_message_count = 0
          WHEN json_valid(messages) THEN json_type(messages) = 'array'
            AND json_array_length(messages) = active_message_count
            AND NOT EXISTS (SELECT 1 FROM json_each(messages) AS item
              WHERE item.type <> 'object' OR json_type(item.value, '$.message_id') IS NOT 'text')
          ELSE 0 END;
    CREATE TEMP TABLE context_listed (
      session_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (session_id, position)
    ) WITHOUT ROWID;
    INSERT INTO context_listed (session_id, position, seq)
      SELECT a.session_id,
        ROW_NUMBER() OVER (PARTITION BY a.session_id ORDER BY item.key),
        m.seq
      FROM context_array AS a
        CROSS JOIN json_each(a.messages) AS item
        CROSS JOIN session_messages AS m
      WHERE m.session_id = a.session_id AND m.message_id = item.value ->> '$.message_id';
    CREATE INDEX temp.context_listed_seq ON context_listed(session_id, seq);
    CREATE TEMP TABLE context_window (
      session_id TEXT PRIMARY KEY,
      head_seq INTEGER,
      from_seq INTEGER NOT NULL,
      active_count INTEGER NOT NULL
    ) WITHOUT ROWID;
    INSERT INTO context_window (session_id, head_seq, from_seq, active_count)
      WITH heads AS (
        SELECT s.session_id,
          (SELECT first.seq FROM context_listed AS first
            JOIN context_listed AS second
              ON second.session_id = first.session_id AND second.position = 2
            WHERE first.session_id = s.session_id AND first.position = 1
              AND first.seq > second.seq) AS head_seq,
          COALESCE((SELECT MAX(seq) FROM session_messages AS m
            WHERE m.session_id = s.session_id), -1) AS newest_seq
        FROM sessions AS s
        WHERE s.context_from_seq IS NULL
      ),
      listed AS (
        SELECT h.session_id, h.head_seq, h.newest_seq,
          (SELECT MIN(l.seq) FROM context_listed AS l
            WHERE l.session_id = h.session_id
              AND (h.head_seq IS NULL OR l.position > 1)) AS first_seq,
          (SELECT COUNT(DISTINCT l.seq) FROM context_listed AS l
            WHERE l.session_id = h.session_id
              AND (h.head_seq IS NULL OR l.position > 1)) AS listed_count
        FROM heads AS h
      )
      SELECT session_id, head_seq,
        COALESCE(first_seq, COALESCE(head_seq, newest_seq) + 1),
        listed_count + (head_seq IS NOT NULL)
      FROM listed;
    DELETE FROM session_context_hidden
      WHERE session_id IN (SELECT session_id FROM context_window);
    INSERT INTO session_context_hidden (session_id, seq)
      SELECT w.session_id, m.seq
      FROM context_window AS w
        JOIN session_messages AS m ON m.session_id = w.session_id AND m.seq >= w.from_seq
      WHERE NOT EXISTS (SELECT 1 FROM context_listed AS l
        WHERE l.session_id = w.session_id AND l.seq = m.seq);
    UPDATE sessions
      SET (context_from_seq, context_head_seq, active_message_count, messages) = (
        SELECT w.from_seq, w.head_seq, w.active_count, NULL
        FROM context_window AS w WHERE w.session_id = sessions.session_id)
      WHERE session_id IN (SELECT session_id FROM context_window);
    DROP TABLE context_window;
    DROP TABLE context_listed;
    DROP TABLE context_array;
    DROP INDEX idx_sessions_context_unconverted;
    ALTER TABLE sessions DROP COLUMN legacy_context_revision;`)
}

export const activeContextWindowOnly: Migration = {
  version: 175,
  name: "active_context_window_only",
  foreignKeys: { kind: "enforced" },
  up
}
