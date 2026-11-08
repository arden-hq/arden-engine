import type { Migration } from "./index.js"

const ANSWER_BLOCK_STATE = `CREATE TABLE answer_block_state (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      message_id TEXT NOT NULL CHECK(length(message_id) > 0),
      block_index INTEGER NOT NULL CHECK(block_index >= 0),
      state_json TEXT NOT NULL CHECK(
        json_valid(state_json) AND json_type(state_json) = 'object' AND length(CAST(state_json AS BLOB)) <= 8192
      ),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, message_id, block_index)
    ) WITHOUT ROWID`

export const answerBlockState: Migration = {
  version: 52,
  name: "answer_block_state",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(ANSWER_BLOCK_STATE)
  }
}
