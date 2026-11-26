import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { databaseSchema } from "../src/persistence/schema/database.js"

// https://www.sqlite.org/foreignkeys.html#fk_indexes
it("every foreign key has an index that starts with a referencing column", () => {
  const database = new DatabaseSync(":memory:")
  try {
    for (const statement of databaseSchema.statements) database.exec(statement)
    const tables = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name))
    const missing: Array<string> = []
    for (const table of tables) {
      const leading = new Set<string>()
      for (const column of database.prepare(`PRAGMA table_info("${table}")`).all()) {
        if (column.pk === 1) leading.add(String(column.name))
      }
      for (const index of database.prepare(`PRAGMA index_list("${table}")`).all()) {
        if (index.partial === 1) continue
        const first = database.prepare(`PRAGMA index_info("${String(index.name)}")`).all()[0]
        if (first?.name != null) leading.add(String(first.name))
      }
      const keys = new Map<number, { parent: string; columns: Array<string> }>()
      for (const key of database.prepare(`PRAGMA foreign_key_list("${table}")`).all()) {
        const entry = keys.get(Number(key.id)) ?? { parent: String(key.table), columns: [] }
        entry.columns.push(String(key.from))
        keys.set(Number(key.id), entry)
      }
      for (const key of keys.values()) {
        if (key.columns.some((column) => leading.has(column))) continue
        missing.push(`${table}(${key.columns.join(", ")}) -> ${key.parent}`)
      }
    }
    expect(missing.toSorted()).toEqual([])
  } finally {
    database.close()
  }
})
