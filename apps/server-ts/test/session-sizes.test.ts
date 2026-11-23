import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { databaseSchema } from "../src/persistence/schema/database.js"

const recount = (database: DatabaseSync) => ({
  chats: database
    .prepare(
      `SELECT s.session_id,
         COALESCE((SELECT SUM(octet_length(message_json)) FROM session_messages
           WHERE session_id = s.session_id), 0) AS message_json_bytes,
         COALESCE((SELECT SUM(COALESCE(octet_length(search_text), 0)) FROM session_messages
           WHERE session_id = s.session_id), 0) AS search_text_bytes,
         COALESCE((SELECT SUM(COALESCE(octet_length(metadata_json), 0)
             + COALESCE(octet_length(error_message), 0)) FROM chat_runs
           WHERE session_id = s.session_id), 0) AS run_bytes
       FROM sessions AS s ORDER BY s.session_id`
    )
    .all(),
  kinds: database
    .prepare(
      `SELECT s.session_type,
         COALESCE(SUM((SELECT SUM(octet_length(message_json)) FROM session_messages
           WHERE session_id = s.session_id)), 0) AS message_json_bytes,
         COALESCE(SUM((SELECT SUM(COALESCE(octet_length(search_text), 0)) FROM session_messages
           WHERE session_id = s.session_id)), 0) AS search_text_bytes,
         COALESCE(SUM((SELECT SUM(COALESCE(octet_length(metadata_json), 0)
             + COALESCE(octet_length(error_message), 0)) FROM chat_runs
           WHERE session_id = s.session_id)), 0) AS run_bytes,
         SUM(COALESCE(octet_length(s.messages), 0) + COALESCE(octet_length(s.metadata), 0)
           + COALESCE(octet_length(s.name), 0)) AS own_bytes,
         COUNT(*) AS sessions, SUM(s.archived_at IS NOT NULL) AS archived
       FROM sessions AS s GROUP BY s.session_type ORDER BY s.session_type`
    )
    .all()
})

const saved = (database: DatabaseSync) => ({
  chats: database
    .prepare(
      `SELECT session_id, message_json_bytes, search_text_bytes, run_bytes FROM session_sizes
       WHERE session_id IN (SELECT session_id FROM sessions) ORDER BY session_id`
    )
    .all(),
  kinds: database
    .prepare(
      `SELECT session_type, message_json_bytes, search_text_bytes, run_bytes, own_bytes,
         sessions, archived
       FROM session_type_sizes WHERE sessions > 0 ORDER BY session_type`
    )
    .all()
})

// The Storage page reads chat sizes from numbers that triggers keep. After
// every kind of change they must equal a fresh count of the rows.
it("saved chat sizes equal a recount after inserts, edits, moves of messages and runs, and deletes", () => {
  const database = new DatabaseSync(":memory:")
  try {
    for (const statement of databaseSchema.statements) database.exec(statement)
    const steps: ReadonlyArray<string> = [
      `INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type, name)
         VALUES ('a', 'ref-a', '2026-09-01', '2026-09-01', 'chat', 'First'),
                ('b', 'ref-b', '2026-09-01', '2026-09-01', 'chat', 'Second'),
                ('c', 'ref-c', '2026-09-01', '2026-09-01', 'channel', NULL)`,
      `INSERT INTO session_messages (session_id, message_id, seq, role, message_json, created_at)
         VALUES ('a', 'm1', 1, 'user', '{"role":"user","content":"hello"}', '2026-09-01'),
                ('a', 'm2', 2, 'assistant', '{"role":"assistant","content":"hi there"}', '2026-09-01'),
                ('c', 'm3', 1, 'user', '{"role":"user","content":"sub"}', '2026-09-01')`,
      `INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at, metadata_json,
           assistant_message_id)
         VALUES ('r1', 'a', 'running', '2026-09-01', '2026-09-01', '{"turn_id":"t1"}', 'am1'),
                ('r2', 'c', 'running', '2026-09-01', '2026-09-01', '{"turn_id":"t2"}', 'am2')`,
      `UPDATE session_messages SET message_json = '{"role":"user","content":"hello again, longer"}',
           search_text = 'hello again' WHERE message_id = 'm1'`,
      `UPDATE chat_runs SET metadata_json = '{"turn_id":"t1","more":"data data data"}' WHERE run_id = 'r1'`,
      `UPDATE chat_runs SET status = 'error', ended_at = '2026-09-01', error_code = 'x',
           error_message = 'it broke' WHERE run_id = 'r2'`,
      `UPDATE sessions SET name = 'Renamed chat', metadata = '{"k":"v"}' WHERE session_id = 'a'`,
      `UPDATE sessions SET archived_at = '2026-09-02' WHERE session_id = 'b'`,
      `UPDATE session_messages SET session_id = 'b' WHERE message_id = 'm1'`,
      `UPDATE chat_runs SET session_id = 'b' WHERE run_id = 'r1'`,
      `DELETE FROM session_messages WHERE message_id = 'm2'`,
      `DELETE FROM session_messages WHERE message_id = 'm1'`,
      `DELETE FROM chat_runs WHERE run_id = 'r2'`,
      `DELETE FROM session_messages WHERE session_id = 'c'`,
      `DELETE FROM sessions WHERE session_id = 'c'`,
      `DELETE FROM chat_runs WHERE run_id = 'r1'`,
      `DELETE FROM sessions WHERE session_id = 'b'`
    ]
    for (const step of steps) {
      database.exec(step)
      expect(saved(database), step).toEqual(recount(database))
    }
    expect(
      database
        .prepare(
          `SELECT COALESCE(SUM(message_json_bytes + search_text_bytes + run_bytes + own_bytes), 0)
             AS total FROM session_type_sizes`
        )
        .get()?.total
    ).toBeGreaterThan(0)
  } finally {
    database.close()
  }
})
