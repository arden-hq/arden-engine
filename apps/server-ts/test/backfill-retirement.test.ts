import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { retireBackfill } from "../src/persistence/migrations/retire-backfill.js"
import { dataBackfillsSchemaSection } from "../src/persistence/schema/sections/data-backfills.js"
import { backfills } from "../src/persistence/sqlite/backfills/index.js"

const MAX_AGE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

const databaseWith = (oldRows: number): DatabaseSync => {
  const database = new DatabaseSync(":memory:")
  for (const statement of dataBackfillsSchemaSection.statements) database.exec(statement)
  database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, format INTEGER NOT NULL)")
  for (let row = 0; row < oldRows; row += 1)
    database.prepare("INSERT INTO notes (format) VALUES (1)").run()
  database
    .prepare(
      "INSERT INTO data_backfills (name, started_at, updated_at, finished_at) VALUES (?, ?, ?, ?)"
    )
    .run("notes_format_two", "2026-11-01", "2026-11-01", oldRows === 0 ? "2026-11-01" : null)
  return database
}

const retirement = retireBackfill({
  version: 999,
  backfill: "notes_format_two",
  remaining: "SELECT 1 FROM notes WHERE format = 1"
})

describe("backfill retirement", () => {
  it("removes every backfill within 30 days of landing", () => {
    const now = Date.now()
    const overdue = backfills.flatMap((backfill) => {
      const age = Math.floor((now - Date.parse(`${backfill.landed}T00:00:00Z`)) / DAY_MS)
      return age > MAX_AGE_DAYS
        ? [`${backfill.name} (landed ${backfill.landed}, ${age} days ago)`]
        : []
    })
    expect(
      overdue,
      `Delete these backfills and add a retireBackfill migration (persistence/migrations/retire-backfill.ts) whose query finds rows they would still convert: ${overdue.join(", ")}`
    ).toEqual([])
  })

  it("lets a database that finished the conversion through and forgets the backfill", () => {
    const database = databaseWith(0)
    retirement.up(database)
    expect(database.prepare("SELECT COUNT(*) AS left FROM data_backfills").get()).toEqual({
      left: 0
    })
  })

  it("stops a database that still has rows the conversion never reached, and changes nothing", () => {
    const database = databaseWith(3)
    expect(() => retirement.up(database)).toThrow(/notes_format_two conversion/)
    expect(database.prepare("SELECT COUNT(*) AS left FROM data_backfills").get()).toEqual({
      left: 1
    })
  })
})
