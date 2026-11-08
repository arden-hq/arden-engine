import { Database } from "bun:sqlite"
import { databaseSchema } from "../apps/server-ts/src/persistence/schema/database.ts"
import { captureStatements } from "../apps/server-ts/src/persistence/sqlite/tells/capture.ts"
import { tableTells } from "../apps/server-ts/src/persistence/sqlite/tells/tables.ts"

/** @type {string[]} */
const problems = []
const schemaTables = new Set(databaseSchema.tables)
const entries = Object.entries(tableTells)

for (const table of schemaTables)
  if (!Object.hasOwn(tableTells, table))
    problems.push(`${table}: neither told nor silent; add it to tells/tables.ts`)
for (const [table, spec] of entries) {
  if (!schemaTables.has(table)) problems.push(`${table}: not a table of the schema`)
  if ("silent" in spec && !/^[A-Z].*\S.*\s.*\S.*[.)]$/.test(spec.silent.trim()))
    problems.push(`${table}: the reason it is silent must be a sentence`)
}

const database = new Database(":memory:")
for (const statement of databaseSchema.statements) database.run(statement)
for (const statement of captureStatements) {
  try {
    database.run(statement)
  } catch (error) {
    problems.push(`capture does not compile: ${error.message}\n  ${statement.split("\n")[0]}`)
  }
}
for (const [table, spec] of entries) {
  if (!("tell" in spec)) continue
  const column = database.query(`SELECT name FROM pragma_table_info('${table}') LIMIT 1`).get()?.name
  for (const write of [
    `INSERT INTO ${table} SELECT * FROM ${table} WHERE 0`,
    `UPDATE ${table} SET ${[...(spec.columns ?? [column])].map((name) => `${name} = ${name}`).join(", ")} WHERE 0`,
    `DELETE FROM ${table} WHERE 0`
  ]) {
    try {
      database.prepare(write)
    } catch (error) {
      problems.push(`${table}: its capture does not compile (${error.message})`)
    }
  }
}

if (problems.length > 0) {
  console.error(`Told tables:\n${problems.map((problem) => `  ${problem}`).join("\n")}`)
  process.exit(1)
}
console.log(
  `Told tables: ${entries.filter(([, spec]) => "tell" in spec).length} told, ${entries.filter(([, spec]) => "silent" in spec).length} silent.`
)
