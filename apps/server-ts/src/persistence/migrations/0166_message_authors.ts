import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

/**
 * Stores who wrote each user message that no writer marked: the owner's typed turns and answers,
 * proven by a chat-started run of the turn or a resolved question, in the chat or a chat it was
 * copied from, and `unknown` where no proof was kept. The `message_authors` backfill stores the
 * marked rest.
 */
const up = (database: DatabaseSync): void => {
  database.exec(`ALTER TABLE session_messages ADD COLUMN author TEXT;
    CREATE TEMP TABLE author_candidates AS
      SELECT message_rowid, session_id, mark ->> 5 IS NOT 1 AS typed,
        CASE WHEN mark ->> 5 IS NOT 1 THEN COALESCE(mark ->> 7, message_id)
          ELSE mark ->> 6 END AS proof
      FROM (SELECT message_rowid, session_id, message_id,
          json_extract(message_json, '$.interaction', '$.from_chat', '$.forked_from',
            '$.sent_from', '$.automation', '$.is_meta', '$.question_answer.question_id',
            '$.turn_id', '$.question_answer') AS mark
        FROM session_messages WHERE role = 'user')
      WHERE mark ->> 0 IS NULL AND mark ->> 1 IS NULL AND mark ->> 2 IS NULL
        AND mark ->> 3 IS NULL AND mark ->> 4 IS NULL
        AND (mark ->> 5 IS NOT 1 OR mark ->> 8 IS NOT NULL);
    CREATE TEMP TABLE author_proofs AS
      WITH RECURSIVE chats(session_id, chat) AS (
        SELECT DISTINCT session_id, session_id FROM author_candidates
        UNION SELECT chats.session_id, json_extract(branch.metadata, '$.fork_origin.sourceSessionId')
        FROM chats JOIN sessions AS branch ON branch.session_id = chats.chat)
      SELECT chats.session_id, 1 AS typed, json_extract(run.metadata_json, '$.turn_id') AS proof
      FROM chats JOIN chat_runs AS run ON run.session_id = chats.chat
      WHERE json_extract(run.metadata_json, '$.run_context.origin.kind') = 'chat'
      UNION SELECT chats.session_id, 0, question.question_id
      FROM chats JOIN chat_runs AS run ON run.session_id = chats.chat
      JOIN run_questions AS question ON question.run_id = run.run_id
      WHERE question.resolution IS NOT NULL;
    UPDATE session_messages SET author = CASE
        WHEN (candidate.session_id, candidate.typed, candidate.proof) IN author_proofs
        THEN CASE WHEN candidate.typed THEN 'owner' ELSE 'answer' END
        ELSE 'unknown' END
      FROM author_candidates AS candidate
      WHERE session_messages.message_rowid = candidate.message_rowid;
    DROP TABLE author_candidates;
    DROP TABLE author_proofs;`)
}

export const messageAuthors: Migration = {
  version: 166,
  name: "message_authors",
  foreignKeys: { kind: "enforced" },
  up
}
