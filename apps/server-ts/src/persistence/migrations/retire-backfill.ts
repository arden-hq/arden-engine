import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

export const retireBackfill = ({
  version,
  backfill,
  remaining
}: {
  readonly version: number
  readonly backfill: string
  readonly remaining: string
}): Migration => ({
  version,
  name: `retire_${backfill}`,
  foreignKeys: { kind: "enforced" },
  up: (database: DatabaseSync): void => {
    const left = database.prepare(`SELECT EXISTS (${remaining}) AS left`).get()
    if (left?.left === 1)
      throw new Error(
        `This data still has rows from before the ${backfill} conversion. Open the Arden release before this one, let it finish converting, then update.`
      )
    database.prepare("DELETE FROM data_backfills WHERE name = ?").run(backfill)
  }
})
