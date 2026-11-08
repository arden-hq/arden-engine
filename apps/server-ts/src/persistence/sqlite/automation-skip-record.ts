import type { SqlClient, Statement } from "effect/unstable/sql"
import type { StoredAutomationRunSkip } from "../automations/store.js"

export const skipEnd = (skip: StoredAutomationRunSkip) => {
  switch (skip.reason) {
    case "prefilter":
      return {
        outcome: "skipped:prefilter",
        result: "Run only if said no to this event; no run started."
      } as const
    case "space_review_gate":
      return {
        outcome: "skipped:space_review_gate",
        result: "Nothing new to review; no run started."
      } as const
  }
}

export const countsAsRun = (sql: SqlClient.SqlClient, run: Statement.Fragment) =>
  sql`(CASE WHEN ${run}.outcome IS NULL
      THEN ${run}.skip_json IS NULL AND ${run}.disposition IS NOT 'superseded'
      ELSE ${run}.outcome <> 'superseded' AND ${run}.outcome NOT GLOB 'skipped:*' END)`
