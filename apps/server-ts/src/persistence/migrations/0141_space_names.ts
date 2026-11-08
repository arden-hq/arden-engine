import type { DatabaseSync } from "node:sqlite"
import { hasOldWord, spaceText, spaceValue } from "../space-words-released.js"
import type { Migration } from "./index.js"

/** "Desk" became "Space". Every table, column, index and trigger named desk is
 * renamed, the old words in their SQL are replaced, and the app's names stored
 * in rows convert (`spaceValue`). The large history tables in LATER convert
 * after start in the space_words backfill. */
export const spaceNames: Migration = {
  version: 141,
  name: "space_names",
  up: (database) => {
    database.function("arden_space_value", { deterministic: true }, (value) => spaceValue(value))
    const objects = schemaObjects(database)
    const rebuilt = new Set(
      objects
        .filter((object) => object.type === "table" && hasOldWord(object.sql))
        .map((o) => o.name)
    )
    const triggers = objects.filter((object) => object.type === "trigger")
    const views = objects.filter((object) => object.type === "view")
    const indexes = objects.filter(
      (object) => object.type === "index" && (hasOldWord(object.sql) || rebuilt.has(object.table))
    )
    for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name}"`)
    for (const view of views) database.exec(`DROP VIEW "${view.name}"`)
    for (const index of indexes) database.exec(`DROP INDEX "${index.name}"`)

    database.exec("PRAGMA legacy_alter_table = ON")
    try {
      for (const table of objects)
        if (rebuilt.has(table.name)) rebuild(database, table.name, table.sql)
    } finally {
      database.exec("PRAGMA legacy_alter_table = OFF")
    }

    const virtual = objects.filter((object) => object.sql.startsWith("CREATE VIRTUAL TABLE"))
    for (const table of objects) {
      if (table.type !== "table" || rebuilt.has(table.name) || LATER.has(table.name)) continue
      if (
        virtual.some(
          (owner) => table.name === owner.name || table.name.startsWith(`${owner.name}_`)
        )
      )
        continue
      convertRows(database, table.name)
    }

    for (const index of indexes) database.exec(spaceText(index.sql))
    for (const view of views) database.exec(spaceText(view.sql))
    for (const trigger of triggers) database.exec(spaceText(trigger.sql))
  }
}

/** Converted after start by the space_words backfill: too large to scan here. */
const LATER = new Set([
  "journal_records",
  "session_messages",
  "message_turns",
  "tool_calls",
  "chat_idempotency_keys",
  "run_model_usage"
])

interface SchemaObject {
  readonly type: string
  readonly name: string
  readonly table: string
  readonly sql: string
}

const schemaObjects = (database: DatabaseSync): ReadonlyArray<SchemaObject> =>
  database
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`
    )
    .all()
    .map((row) => ({
      type: String(row["type"]),
      name: String(row["name"]),
      table: String(row["tbl_name"]),
      sql: String(row["sql"])
    }))

const columnsOf = (database: DatabaseSync, table: string): ReadonlyArray<string> =>
  database
    .prepare("SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0")
    .all(table)
    .map((row) => String(row["name"]))

const sqlName = (name: string): string => `"${name.replaceAll('"', '""')}"`

const PRIOR = "arden_space_rename_prior"

/** Copy the table into one created from its renamed SQL, converting each
 * value. legacy_alter_table keeps other tables' references by name. */
const rebuild = (database: DatabaseSync, table: string, sql: string): void => {
  const columns = columnsOf(database, table)
  const sequence = database.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table)?.[
    "seq"
  ]
  database.exec(`ALTER TABLE ${sqlName(table)} RENAME TO ${PRIOR}`)
  database.exec(spaceText(sql))
  const target = spaceText(table)
  database.exec(
    `INSERT INTO ${sqlName(target)} (${columns.map((column) => sqlName(spaceText(column))).join(", ")})
    SELECT ${columns.map((column) => `arden_space_value(${sqlName(column)})`).join(", ")} FROM ${PRIOR}`
  )
  database.exec(`DROP TABLE ${PRIOR}`)
  if (typeof sequence === "number") {
    database.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(target)
    database.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(target, sequence)
  }
}

const convertRows = (database: DatabaseSync, table: string): void => {
  const columns = columnsOf(database, table)
  if (columns.length === 0) return
  const matches = columns
    .flatMap((column) =>
      ["desk", "Desk", "DESK"].map((word) => `instr(${sqlName(column)}, '${word}') > 0`)
    )
    .join(" OR ")
  database.exec(
    `UPDATE ${sqlName(table)}
    SET ${columns.map((column) => `${sqlName(column)} = arden_space_value(${sqlName(column)})`).join(", ")}
    WHERE ${matches}`
  )
}
