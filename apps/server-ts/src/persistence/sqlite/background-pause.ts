import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { activeRunStatusList } from "./status-sets.js"
import type { SqlError } from "effect/unstable/sql/SqlError"

const IDLE_GAP = "50 millis"
const BUSY_GAP = "1 second"

/** Whether any run is active: background work between batches gives way to it. */
export const runIsActive = (reader: SqlClient.SqlClient): Effect.Effect<boolean, SqlError, never> =>
  reader<{ readonly active: number }>`
    SELECT 1 AS active FROM chat_runs WHERE status IN ${activeRunStatusList} LIMIT 1`.pipe(
    Effect.map((rows) => rows.length > 0)
  )

/** The pause between batches of background work (backfills, journal
 * retention): short while idle, long while a run is active. */
export const pauseBetweenBatches = (active: boolean): Effect.Effect<void, never, never> =>
  Effect.sleep(active ? BUSY_GAP : IDLE_GAP)
