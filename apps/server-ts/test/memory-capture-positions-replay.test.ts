import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { MemoryCaptureStore } from "../src/persistence/memory/store.js";
import { listCaptureWork } from "../src/persistence/sqlite/memory-capture-positions.js";
import {
  locateReplayCopy,
  rollBackOnReplayCopy,
  rolledBack,
  runOnReplayCopy,
} from "./fixtures/replay-copy.js";

// Capture positions over the real history, with no model. The copy is opened the way the
// server opens it, so migration 0155 runs on it. Every appended turn runs through
// rollBackOnReplayCopy, so the copy stays as it was. Only counts leave this file.

const located = locateReplayCopy();

const OWNER =
  "session.session_type = 'chat' AND session.origin_automation_id IS NULL";

it("starts every owner chat at its end, with no old turn queued and no old mark left, on the real history", async (context) => {
  if (located.kind === "absent") return context.skip(located.reason);
  const migrated = await runOnReplayCopy(
    located.copy,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const captures = yield* MemoryCaptureStore;
      const [counts] = yield* sql<{
        readonly owner: number;
        readonly positions: number;
        readonly ranges: number;
        readonly marks: number;
      }>`SELECT
        (SELECT COUNT(*) FROM sessions AS session WHERE ${sql.literal(OWNER)}) AS owner,
        (SELECT COUNT(*) FROM memory_capture_unread AS position
          JOIN sessions AS session ON session.session_id = position.session_id
          WHERE ${sql.literal(OWNER)} AND position.through_seq IS NULL) AS positions,
        (SELECT COUNT(*) FROM memory_capture_unread WHERE through_seq IS NOT NULL) AS ranges,
        (SELECT COUNT(*) FROM run_sidecars
          WHERE json_type(evidence_json, '$.memory_capture') IS NOT NULL) AS marks`;
      return { counts, work: (yield* captures.listWork(false, 100)).length };
    }),
  );
  const replayed = await rollBackOnReplayCopy(located.copy, replay);
  // Vitest swallows console output; a direct write reaches the terminal.
  process.stdout.write(
    `Replay: ${migrated.counts?.owner} owner chats, ${migrated.counts?.positions} positions, ` +
      `${migrated.work} listed after the update. A new turn lists ${replayed.listed} of ` +
      `${replayed.chats} owner chats from their position.\n`,
  );
  expect(migrated).toEqual({
    counts: {
      owner: migrated.counts?.owner,
      positions: migrated.counts?.owner,
      ranges: 0,
      marks: 0,
    },
    work: 0,
  });
  expect(replayed.listed).toBe(replayed.chats);
});

const replay = Effect.fn("replay")(function* (sql: SqlClient.SqlClient) {
  const chats = yield* sql<{
    readonly session_id: string;
    readonly next_seq: number;
  }>`
    SELECT session.session_id,
      COALESCE((SELECT MAX(seq) + 1 FROM session_messages
        WHERE session_id = session.session_id), 0) AS next_seq
    FROM sessions AS session WHERE ${sql.literal(OWNER)}`;
  let listed = 0;
  for (const chat of chats) {
    const work = yield* rolledBack(
      sql,
      Effect.gen(function* () {
        yield* sql`INSERT INTO session_messages
          (session_id, message_id, seq, role, message_json, created_at, search_text)
          VALUES (${chat.session_id}, 'replay-turn', ${chat.next_seq}, 'user',
            ${JSON.stringify({
              message_id: "replay-turn",
              role: "user",
              content: "replay",
              created_at: "2026-11-14T00:00:00.000Z",
            })}, '2026-11-14T00:00:00.000Z', 'replay')`;
        return yield* listCaptureWork(sql, 100, false);
      }),
    );
    const stored = yield* sql<{ readonly read_seq: number }>`SELECT read_seq
      FROM memory_capture_unread WHERE session_id = ${chat.session_id} AND through_seq IS NULL`;
    const own = work.find((item) => item.sessionId === chat.session_id);
    const from = stored[0]?.read_seq ?? -1;
    if (
      own !== undefined &&
      own.throughSequence === chat.next_seq &&
      (from < 0
        ? own.position._tag === "Beginning"
        : own.position._tag === "AfterSequence" &&
          own.position.sequence === from)
    )
      listed += 1;
  }
  return { chats: chats.length, listed };
});
