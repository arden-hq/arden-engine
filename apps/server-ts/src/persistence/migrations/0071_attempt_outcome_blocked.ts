import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

const before = `            WHEN disposition IN ('needs_you', 'no_change') THEN disposition
            ELSE 'finished' END`

const after = `            WHEN disposition = 'needs_you' THEN 'needs_you'
            WHEN EXISTS (SELECT 1 FROM run_sidecars AS sidecar WHERE sidecar.run_id = automation_runs.chat_run_id
              AND json_extract(sidecar.evidence_json, '$.automation_outcome') IS NOT NULL) THEN 'blocked'
            WHEN disposition = 'no_change' THEN 'no_change'
            ELSE 'finished' END`

const up = (database: DatabaseSync): void => {
  const row = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'worker_attempt_state'"
    )
    .get()
  const current = row?.["sql"]
  if (typeof current !== "string" || !current.includes(before))
    throw new Error("worker_attempt_state is not the trigger 0068 made")
  database.exec("DROP TRIGGER worker_attempt_state")
  database.exec(current.replace(before, after))
}

export const attemptOutcomeBlocked: Migration = {
  version: 71,
  name: "attempt_outcome_blocked",
  foreignKeys: { kind: "enforced" },
  up
}
