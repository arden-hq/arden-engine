import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { readRunCause } from "./run-cause.js"

export const appendRunsFencedInTransaction = Effect.fn("SessionLifecycleEvents.appendRunsFenced")(
  function* (
    sql: SqlClient.SqlClient,
    sessionEvents: SessionLifecycleEvents["Service"],
    runs: ReadonlyArray<{ readonly run_id: string; readonly session_id: string }>
  ) {
    for (const run of runs) {
      yield* sessionEvents.appendEventInTransaction({
        type: "run_fenced",
        run_id: run.run_id,
        session_id: run.session_id,
        ...(yield* readRunCause(sql, run.run_id))
      })
    }
  }
)
