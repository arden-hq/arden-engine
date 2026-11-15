/**
 * Statements allowed to read a growing table from start to end, each with
 * the reason that is acceptable. Keep this list short: the fix for a new
 * entry is almost always to start the query from a key or a short list.
 * `id` comes from the failure message of the scan check.
 */
export interface ApprovedScan {
  readonly id: string
  readonly table: string
  readonly reason: string
}

export const APPROVED_SCANS: ReadonlyArray<ApprovedScan> = [
  {
    id: "d1d2fb8184ea",
    table: "chat_runs",
    reason: "First fill of the usage rollup from every run. Runs only while usage_daily is empty."
  },
  {
    id: "1451b6c58c1e",
    table: "sessions",
    reason:
      "Counts what the chat-history backfill has left, for the Storage page. Asked only while that backfill is unfinished; a finished one reports zero without a query."
  },
  {
    id: "87109edd77d5",
    table: "usage_daily",
    reason: "Asks only whether the table has a row: EXISTS stops at the first one."
  },
  {
    id: "e5a4adf47b55",
    table: "run_sidecars",
    reason:
      "Counts the old Memory Capture marks the capture backlog backfill has left, for the Storage page. Asked only while that backfill is unfinished."
  }
]
