import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { orphanAgentSessionsBackfill } from "../src/persistence/sqlite/orphan-agent-sessions-backfill.js"
import { SessionLifecycleEvents } from "../src/persistence/sessions/events.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { inUnitOfWork } from "./fixtures/unit-of-work.js"

const AT = "2026-10-25T09:00:00.000Z"

it("deletes agents whose chat is gone with their own agents and data, once, and keeps busy or parented agents", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sessionEvents = yield* SessionLifecycleEvents
      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity)
        VALUES ('chat', 'chat', ${AT}, ${AT})`
      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
        session_type, parent_session_id, parent_run_id, parent_tool_call_id)
        VALUES ('a-orphan', 'a-orphan', ${AT}, ${AT}, 'agent', 'deleted-chat', 'run', 'call-a-orphan'),
          ('b-nested', 'b-nested', ${AT}, ${AT}, 'agent', 'a-orphan', 'run', 'call-b-nested'),
          ('c-busy', 'c-busy', ${AT}, ${AT}, 'agent', 'deleted-chat', 'run', 'call-c-busy'),
          ('d-parented', 'd-parented', ${AT}, ${AT}, 'agent', 'chat', 'run', 'call-d-parented')`
      yield* sql`INSERT INTO chat_runs
        (run_id, session_id, status, started_at, updated_at, ended_at, assistant_message_id)
        VALUES ('nested-run', 'b-nested', 'completed', ${AT}, ${AT}, ${AT}, 'nested-answer'),
          ('busy-run', 'c-busy', 'running', ${AT}, ${AT}, NULL, 'busy-answer')`
      const chunk = (cursor: string | undefined) =>
        sql.withTransaction(
          inUnitOfWork(orphanAgentSessionsBackfill.chunk({ cursor, limit: 200 })).pipe(
            Effect.provideService(SessionLifecycleEvents, sessionEvents)
          )
        )

      const before = yield* orphanAgentSessionsBackfill.remaining
      const first = yield* chunk(undefined)
      const end = yield* chunk(first.next)
      const again = yield* chunk(undefined)
      return {
        before,
        first,
        end,
        again,
        remaining: yield* orphanAgentSessionsBackfill.remaining,
        sessions: yield* sql`SELECT session_id FROM sessions ORDER BY session_id`,
        runs: yield* sql`SELECT run_id FROM chat_runs ORDER BY run_id`
      }
    })
  )

  expect(result).toEqual({
    before: 2,
    first: { converted: 2, next: "c-busy" },
    end: { converted: 0, next: undefined },
    again: { converted: 0, next: "c-busy" },
    remaining: 1,
    sessions: [{ session_id: "c-busy" }, { session_id: "chat" }, { session_id: "d-parented" }],
    runs: [{ run_id: "busy-run" }]
  })
})

it("skips an orphan whose delete fails, keeping its whole tree, and still deletes the next ones", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sessionEvents = yield* SessionLifecycleEvents
      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity,
        session_type, parent_session_id, parent_run_id, parent_tool_call_id)
        VALUES ('a-ok', 'a-ok', ${AT}, ${AT}, 'agent', 'deleted-chat', 'run', 'call-a-ok'),
          ('b-bad', 'b-bad', ${AT}, ${AT}, 'agent', 'deleted-chat', 'run', 'call-b-bad'),
          ('b-child', 'b-child', ${AT}, ${AT}, 'agent', 'b-bad', 'run', 'call-b-child'),
          ('c-ok', 'c-ok', ${AT}, ${AT}, 'agent', 'deleted-chat', 'run', 'call-c-ok')`
      yield* sql`CREATE TRIGGER refuse_b_bad BEFORE DELETE ON sessions
        WHEN OLD.session_id = 'b-bad' BEGIN SELECT RAISE(ABORT, 'refused'); END`
      const first = yield* sql.withTransaction(
        inUnitOfWork(orphanAgentSessionsBackfill.chunk({ cursor: undefined, limit: 200 })).pipe(
          Effect.provideService(SessionLifecycleEvents, sessionEvents)
        )
      )
      return {
        first,
        sessions: yield* sql`SELECT session_id FROM sessions ORDER BY session_id`
      }
    })
  )

  expect(result).toEqual({
    first: { converted: 2, next: "c-ok" },
    sessions: [{ session_id: "b-bad" }, { session_id: "b-child" }]
  })
})
