import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { RunQueries } from "../src/persistence/runs/queries.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// The Run list returned every Run the server holds, which reads the whole
// table. It now returns a page from a cursor, one chat's Runs, or the Runs
// still going; `anyActive` speaks for the whole server whatever the filter.
it("lists Runs a page at a time, by chat, and only those still going", async () => {
  const result = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const queries = yield* RunQueries
      yield* sql`INSERT INTO sessions (session_id, public_ref, started_at, last_activity, session_type, name)
        VALUES ('one', 'ref-one', '2026-09-01', '2026-09-01', 'chat', 'One'),
               ('two', 'ref-two', '2026-09-01', '2026-09-01', 'chat', 'Two')`
      // r2 and r3 start at the same moment: the cursor must not skip or repeat either.
      for (const [id, session, at, status] of [
        ["r1", "one", "2026-09-02T00:00:01.000Z", "completed"],
        ["r2", "two", "2026-09-02T00:00:02.000Z", "completed"],
        ["r3", "one", "2026-09-02T00:00:02.000Z", "completed"],
        ["r4", "two", "2026-09-02T00:00:04.000Z", "running"],
        ["r5", "one", "2026-09-02T00:00:05.000Z", "completed"]
      ] as const)
        yield* sql`INSERT INTO chat_runs (run_id, session_id, status, started_at, updated_at,
            ended_at, metadata_json, assistant_message_id)
          VALUES (${id}, ${session}, ${status}, ${at}, ${at}, ${status === "running" ? null : at},
            ${JSON.stringify({ turn_id: `t-${id}` })}, ${`am-${id}`})`
      const ids = (page: { readonly runs: ReadonlyArray<{ readonly runId: string }> }) =>
        page.runs.map((run) => run.runId)
      const pages: Array<ReadonlyArray<string>> = []
      let after: { readonly startedAt: string; readonly runId: string } | undefined
      for (;;) {
        const page = yield* queries.list({
          ...(after === undefined ? {} : { after }),
          activeOnly: false,
          limit: 2
        })
        pages.push(ids(page))
        const last = page.runs.at(-1)
        if (!page.more || last === undefined) break
        after = { startedAt: last.startedAt, runId: last.runId }
      }
      const ofOne = yield* queries.list({ sessionId: "one", activeOnly: false, limit: 10 })
      const going = yield* queries.list({ activeOnly: true, limit: 10 })
      yield* sql`UPDATE chat_runs SET status = 'completed', ended_at = updated_at WHERE run_id = 'r4'`
      const exact = yield* queries.list({ activeOnly: false, limit: 5 })
      const quiet = yield* queries.list({ sessionId: "one", activeOnly: true, limit: 10 })
      return {
        pages,
        ofOne: ids(ofOne),
        going: ids(going),
        anyActiveWhileGoing: ofOne.anyActive,
        exactFit: { runs: ids(exact).length, more: exact.more },
        quiet: { runs: ids(quiet), anyActive: quiet.anyActive }
      }
    })
  )
  expect(result).toEqual({
    pages: [["r1", "r2"], ["r3", "r4"], ["r5"]],
    ofOne: ["r1", "r3", "r5"],
    going: ["r4"],
    anyActiveWhileGoing: true,
    exactFit: { runs: 5, more: false },
    quiet: { runs: [], anyActive: false }
  })
})
