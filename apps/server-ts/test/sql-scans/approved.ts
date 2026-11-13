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
    id: "41877cc67f7c",
    table: "session_messages",
    reason:
      "Rebuilds the search index from every message. Runs only when the search database is new or was reset."
  },
  {
    id: "85b930dd4659",
    table: "chat_runs",
    reason: "First fill of the usage rollup from every run. Runs only while usage_daily is empty."
  },
  {
    id: "87109edd77d5",
    table: "usage_daily",
    reason: "Asks only whether the table has a row: EXISTS stops at the first one."
  },
  {
    id: "459a89eb7688",
    table: "sessions",
    reason:
      "Storage page total: sums the size of every chat. Runs only when the user opens Storage, on a reader connection. Known slow (17 s on an 8 GB database); a saved size per chat would remove it."
  }
]
