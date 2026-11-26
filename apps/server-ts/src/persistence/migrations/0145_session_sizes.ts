import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const up = (database: DatabaseSync): void => {
  database.exec(`CREATE TABLE session_sizes (
      session_id TEXT PRIMARY KEY,
      message_json_bytes INTEGER NOT NULL DEFAULT 0,
      search_text_bytes INTEGER NOT NULL DEFAULT 0,
      run_bytes INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID`)
  database.exec(`CREATE TABLE session_type_sizes (
      session_type TEXT PRIMARY KEY,
      message_json_bytes INTEGER NOT NULL DEFAULT 0,
      search_text_bytes INTEGER NOT NULL DEFAULT 0,
      run_bytes INTEGER NOT NULL DEFAULT 0,
      own_bytes INTEGER NOT NULL DEFAULT 0,
      sessions INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID`)
  database.exec(`INSERT INTO session_sizes(session_id, message_json_bytes, search_text_bytes)
      SELECT session_id, SUM(octet_length(message_json)), SUM(COALESCE(octet_length(search_text), 0))
      FROM session_messages GROUP BY session_id`)
  database.exec(`INSERT INTO session_sizes(session_id, run_bytes)
      SELECT run.session_id, SUM(COALESCE(octet_length(run.metadata_json), 0) + COALESCE(octet_length(run.error_message), 0)) FROM chat_runs AS run WHERE 1 GROUP BY run.session_id
      ON CONFLICT(session_id) DO UPDATE SET run_bytes = excluded.run_bytes`)
  database.exec(`INSERT OR IGNORE INTO session_sizes(session_id) SELECT session_id FROM sessions`)
  database.exec(`INSERT INTO session_type_sizes(session_type, message_json_bytes, search_text_bytes, run_bytes,
        own_bytes, sessions, archived)
      SELECT s.session_type, SUM(z.message_json_bytes), SUM(z.search_text_bytes), SUM(z.run_bytes),
        SUM(COALESCE(octet_length(s.messages), 0) + COALESCE(octet_length(s.metadata), 0) + COALESCE(octet_length(s.name), 0)), COUNT(*), SUM(s.archived_at IS NOT NULL)
      FROM sessions AS s JOIN session_sizes AS z ON z.session_id = s.session_id
      GROUP BY s.session_type`)
  database.exec(`CREATE TRIGGER session_sizes_message_ai
      AFTER INSERT ON session_messages BEGIN
        INSERT INTO session_sizes(session_id, message_json_bytes, search_text_bytes)
          VALUES (new.session_id, octet_length(new.message_json), COALESCE(octet_length(new.search_text), 0))
          ON CONFLICT(session_id) DO UPDATE SET
            message_json_bytes = message_json_bytes + excluded.message_json_bytes,
            search_text_bytes = search_text_bytes + excluded.search_text_bytes;
        UPDATE session_type_sizes SET
            message_json_bytes = message_json_bytes + octet_length(new.message_json),
            search_text_bytes = search_text_bytes + COALESCE(octet_length(new.search_text), 0)
          WHERE session_type = (SELECT session_type FROM sessions WHERE session_id = new.session_id);
      END`)
  database.exec(`CREATE TRIGGER session_sizes_message_ad
      AFTER DELETE ON session_messages BEGIN
        UPDATE session_sizes SET
            message_json_bytes = message_json_bytes - octet_length(old.message_json),
            search_text_bytes = search_text_bytes - COALESCE(octet_length(old.search_text), 0)
          WHERE session_id = old.session_id;
        UPDATE session_type_sizes SET
            message_json_bytes = message_json_bytes - octet_length(old.message_json),
            search_text_bytes = search_text_bytes - COALESCE(octet_length(old.search_text), 0)
          WHERE session_type = (SELECT session_type FROM sessions WHERE session_id = old.session_id);
      END`)
  database.exec(`CREATE TRIGGER session_sizes_message_au
      AFTER UPDATE OF session_id, message_json, search_text ON session_messages BEGIN
        UPDATE session_sizes SET
            message_json_bytes = message_json_bytes - octet_length(old.message_json),
            search_text_bytes = search_text_bytes - COALESCE(octet_length(old.search_text), 0)
          WHERE session_id = old.session_id;
        UPDATE session_type_sizes SET
            message_json_bytes = message_json_bytes - octet_length(old.message_json),
            search_text_bytes = search_text_bytes - COALESCE(octet_length(old.search_text), 0)
          WHERE session_type = (SELECT session_type FROM sessions WHERE session_id = old.session_id);
        INSERT INTO session_sizes(session_id, message_json_bytes, search_text_bytes)
          VALUES (new.session_id, octet_length(new.message_json), COALESCE(octet_length(new.search_text), 0))
          ON CONFLICT(session_id) DO UPDATE SET
            message_json_bytes = message_json_bytes + excluded.message_json_bytes,
            search_text_bytes = search_text_bytes + excluded.search_text_bytes;
        UPDATE session_type_sizes SET
            message_json_bytes = message_json_bytes + octet_length(new.message_json),
            search_text_bytes = search_text_bytes + COALESCE(octet_length(new.search_text), 0)
          WHERE session_type = (SELECT session_type FROM sessions WHERE session_id = new.session_id);
      END`)
  database.exec(`CREATE TRIGGER session_sizes_run_ai
      AFTER INSERT ON chat_runs BEGIN
        INSERT INTO session_sizes(session_id, run_bytes) VALUES (new.session_id, COALESCE(octet_length(new.metadata_json), 0) + COALESCE(octet_length(new.error_message), 0))
          ON CONFLICT(session_id) DO UPDATE SET run_bytes = run_bytes + excluded.run_bytes;
        UPDATE session_type_sizes SET run_bytes = run_bytes + COALESCE(octet_length(new.metadata_json), 0) + COALESCE(octet_length(new.error_message), 0)
          WHERE session_type = (SELECT session_type FROM sessions WHERE session_id = new.session_id);
      END`)
  database.exec(`CREATE TRIGGER session_sizes_run_ad
      AFTER DELETE ON chat_runs BEGIN
        UPDATE session_sizes SET run_bytes = run_bytes - (COALESCE(octet_length(old.metadata_json), 0) + COALESCE(octet_length(old.error_message), 0))
          WHERE session_id = old.session_id;
        UPDATE session_type_sizes SET run_bytes = run_bytes - (COALESCE(octet_length(old.metadata_json), 0) + COALESCE(octet_length(old.error_message), 0))
          WHERE session_type = (SELECT session_type FROM sessions WHERE session_id = old.session_id);
      END`)
  database.exec(`CREATE TRIGGER session_sizes_run_au
      AFTER UPDATE OF session_id, metadata_json, error_message ON chat_runs BEGIN
        UPDATE session_sizes SET run_bytes = run_bytes - (COALESCE(octet_length(old.metadata_json), 0) + COALESCE(octet_length(old.error_message), 0))
          WHERE session_id = old.session_id;
        UPDATE session_type_sizes SET run_bytes = run_bytes - (COALESCE(octet_length(old.metadata_json), 0) + COALESCE(octet_length(old.error_message), 0))
          WHERE session_type = (SELECT session_type FROM sessions WHERE session_id = old.session_id);
        INSERT INTO session_sizes(session_id, run_bytes) VALUES (new.session_id, COALESCE(octet_length(new.metadata_json), 0) + COALESCE(octet_length(new.error_message), 0))
          ON CONFLICT(session_id) DO UPDATE SET run_bytes = run_bytes + excluded.run_bytes;
        UPDATE session_type_sizes SET run_bytes = run_bytes + COALESCE(octet_length(new.metadata_json), 0) + COALESCE(octet_length(new.error_message), 0)
          WHERE session_type = (SELECT session_type FROM sessions WHERE session_id = new.session_id);
      END`)
  database.exec(`CREATE TRIGGER session_sizes_session_ai
      AFTER INSERT ON sessions BEGIN
        INSERT OR IGNORE INTO session_sizes(session_id) VALUES (new.session_id);
        INSERT INTO session_type_sizes(session_type, message_json_bytes, search_text_bytes,
            run_bytes, own_bytes, sessions, archived)
          VALUES (new.session_type, COALESCE((SELECT message_json_bytes FROM session_sizes WHERE session_id = new.session_id), 0), COALESCE((SELECT search_text_bytes FROM session_sizes WHERE session_id = new.session_id), 0),
            COALESCE((SELECT run_bytes FROM session_sizes WHERE session_id = new.session_id), 0), COALESCE(octet_length(new.messages), 0) + COALESCE(octet_length(new.metadata), 0) + COALESCE(octet_length(new.name), 0), 1, new.archived_at IS NOT NULL)
          ON CONFLICT(session_type) DO UPDATE SET
            message_json_bytes = message_json_bytes + excluded.message_json_bytes,
            search_text_bytes = search_text_bytes + excluded.search_text_bytes,
            run_bytes = run_bytes + excluded.run_bytes,
            own_bytes = own_bytes + excluded.own_bytes,
            sessions = sessions + 1,
            archived = archived + excluded.archived;
      END`)
  database.exec(`CREATE TRIGGER session_sizes_session_ad
      AFTER DELETE ON sessions BEGIN
        UPDATE session_type_sizes SET
            message_json_bytes = message_json_bytes - COALESCE((SELECT message_json_bytes FROM session_sizes WHERE session_id = old.session_id), 0),
            search_text_bytes = search_text_bytes - COALESCE((SELECT search_text_bytes FROM session_sizes WHERE session_id = old.session_id), 0),
            run_bytes = run_bytes - COALESCE((SELECT run_bytes FROM session_sizes WHERE session_id = old.session_id), 0),
            own_bytes = own_bytes - (COALESCE(octet_length(old.messages), 0) + COALESCE(octet_length(old.metadata), 0) + COALESCE(octet_length(old.name), 0)),
            sessions = sessions - 1,
            archived = archived - (old.archived_at IS NOT NULL)
          WHERE session_type = old.session_type;
        DELETE FROM session_sizes WHERE session_id = old.session_id;
      END`)
  database.exec(`CREATE TRIGGER session_sizes_session_au
      AFTER UPDATE OF session_type, archived_at, messages, metadata, name ON sessions BEGIN
        UPDATE session_type_sizes SET
            message_json_bytes = message_json_bytes - COALESCE((SELECT message_json_bytes FROM session_sizes WHERE session_id = old.session_id), 0),
            search_text_bytes = search_text_bytes - COALESCE((SELECT search_text_bytes FROM session_sizes WHERE session_id = old.session_id), 0),
            run_bytes = run_bytes - COALESCE((SELECT run_bytes FROM session_sizes WHERE session_id = old.session_id), 0),
            own_bytes = own_bytes - (COALESCE(octet_length(old.messages), 0) + COALESCE(octet_length(old.metadata), 0) + COALESCE(octet_length(old.name), 0)),
            sessions = sessions - 1,
            archived = archived - (old.archived_at IS NOT NULL)
          WHERE session_type = old.session_type;
        INSERT INTO session_type_sizes(session_type, message_json_bytes, search_text_bytes,
            run_bytes, own_bytes, sessions, archived)
          VALUES (new.session_type, COALESCE((SELECT message_json_bytes FROM session_sizes WHERE session_id = new.session_id), 0), COALESCE((SELECT search_text_bytes FROM session_sizes WHERE session_id = new.session_id), 0),
            COALESCE((SELECT run_bytes FROM session_sizes WHERE session_id = new.session_id), 0), COALESCE(octet_length(new.messages), 0) + COALESCE(octet_length(new.metadata), 0) + COALESCE(octet_length(new.name), 0), 1, new.archived_at IS NOT NULL)
          ON CONFLICT(session_type) DO UPDATE SET
            message_json_bytes = message_json_bytes + excluded.message_json_bytes,
            search_text_bytes = search_text_bytes + excluded.search_text_bytes,
            run_bytes = run_bytes + excluded.run_bytes,
            own_bytes = own_bytes + excluded.own_bytes,
            sessions = sessions + 1,
            archived = archived + excluded.archived;
      END`)
}

export const sessionSizes: Migration = {
  version: 145,
  name: "session_sizes",
  foreignKeys: { kind: "enforced" },
  up
}
