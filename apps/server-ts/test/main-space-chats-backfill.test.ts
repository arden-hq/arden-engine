import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { mainSpaceChatsBackfill } from "../src/persistence/sqlite/main-space-chats-backfill.js"
import { SessionLifecycleEvents } from "../src/persistence/sessions/events.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { inUnitOfWork } from "./fixtures/unit-of-work.js"

const AT = "2026-11-20T00:00:00.000Z"
const LONG_KEY = "k".repeat(80)

it("moves every owner chat with no Space into Main, with its chat Tasks and their records", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sessionEvents = yield* SessionLifecycleEvents
      const main = (yield* sql<{ readonly space_id: string }>`
        SELECT space_id FROM spaces WHERE kind = 'main'`)[0]?.space_id
      yield* sql`INSERT INTO spaces (space_id, name, name_key, created_at, updated_at)
        VALUES ('work', 'Work', 'work', ${AT}, ${AT})`
      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
          session_type, space_id, origin_automation_id, parent_session_id, parent_run_id,
          parent_tool_call_id, archived_at)
        VALUES ('loose', 'loose', ${AT}, ${AT}, 'chat', NULL, NULL, NULL, NULL, NULL, NULL),
          ('loose-agent', 'loose-agent', ${AT}, ${AT}, 'agent', NULL, NULL, 'loose', 'run', 'call', NULL),
          ('loose-old', 'loose-old', ${AT}, ${AT}, 'chat', NULL, NULL, NULL, NULL, NULL, ${AT}),
          ('filed', 'filed', ${AT}, ${AT}, 'chat', 'work', NULL, NULL, NULL, NULL, NULL),
          ('automation', 'automation', ${AT}, ${AT}, 'channel', NULL, 'daily', NULL, NULL, NULL, NULL),
          ('automation-run', 'automation-run', ${AT}, ${AT}, 'chat', NULL, 'daily', 'automation', NULL, NULL, NULL)`
      yield* sql`INSERT INTO space_tasks (item_id, space_id, home_session_id, stable_key, text,
          status, owner, runs_in, created_at, updated_at)
        VALUES ('first', NULL, 'loose', ${LONG_KEY}, 'Reply', 'open', 'worker', 'chat', ${AT}, ${AT}),
          ('second', NULL, 'loose-old', ${LONG_KEY}, 'Reply', 'open', 'worker', 'chat', ${AT}, ${AT}),
          ('automation-task', NULL, 'automation', 'reply', 'Reply', 'open', 'worker', 'chat', ${AT}, ${AT})`
      yield* sql`INSERT INTO space_task_comments (space_id, item_id, author, body, created_at)
        VALUES (NULL, 'first', 'user', 'Note', ${AT})`
      yield* sql`INSERT INTO space_task_events (space_id, item_id, event_type, summary, created_at)
        VALUES (NULL, 'second', 'created', 'Reply', ${AT})`
      yield* sql`INSERT INTO space_task_attachments (space_id, item_id, name, media_type, data,
          size, created_by, created_at)
        VALUES (NULL, 'first', 'a.txt', 'text/plain', X'61', 1, 'user', ${AT})`
      const chunk = (cursor: string | undefined) =>
        sql.withTransaction(
          inUnitOfWork(mainSpaceChatsBackfill.chunk({ cursor, limit: 200 })).pipe(
            Effect.provideService(SessionLifecycleEvents, sessionEvents)
          )
        )
      const before = yield* mainSpaceChatsBackfill.remaining
      const first = yield* chunk(undefined)
      const end = yield* chunk(first.next)
      const inMain = (rows: ReadonlyArray<{ readonly space_id: string | null }>) =>
        rows.map((row) => ({ ...row, space_id: row.space_id === main ? "main" : row.space_id }))
      return {
        before,
        first,
        end,
        remaining: yield* mainSpaceChatsBackfill.remaining,
        sessions: inMain(yield* sql`SELECT session_id, space_id FROM sessions ORDER BY session_id`),
        tasks: inMain(
          yield* sql`SELECT item_id, space_id, stable_key FROM space_tasks ORDER BY item_id`
        ),
        records: inMain(
          yield* sql`SELECT 'comment' AS kind, space_id FROM space_task_comments
            UNION ALL SELECT 'event', space_id FROM space_task_events
            UNION ALL SELECT 'attachment', space_id FROM space_task_attachments ORDER BY kind`
        )
      }
    })
  )
  expect(result).toEqual({
    before: 3,
    first: { converted: 3, next: "loose-old" },
    end: { converted: 0, next: undefined },
    remaining: 0,
    sessions: [
      { session_id: "automation", space_id: null },
      { session_id: "automation-run", space_id: null },
      { session_id: "filed", space_id: "work" },
      { session_id: "loose", space_id: "main" },
      { session_id: "loose-agent", space_id: "main" },
      { session_id: "loose-old", space_id: "main" }
    ],
    tasks: [
      { item_id: "automation-task", space_id: null, stable_key: "reply" },
      { item_id: "first", space_id: "main", stable_key: LONG_KEY },
      { item_id: "second", space_id: "main", stable_key: `${"k".repeat(78)}-2` }
    ],
    records: [
      { kind: "attachment", space_id: "main" },
      { kind: "comment", space_id: "main" },
      { kind: "event", space_id: "main" }
    ]
  })
})
