import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { tableTells, type TableTell, type TellKind } from "./tables.js"

export interface Touch {
  readonly kind: TellKind
  readonly id: string | null
  readonly scope: string | null
  readonly source: string
  readonly renamed: number
  readonly unlisted: number
  readonly seq: number
}

type ToldTable = Extract<TableTell, { readonly tell: TellKind }>

const at = (expression: string, row: "NEW" | "OLD") => expression.replaceAll("{row}", row)

const values = (table: string, spec: ToldTable, row: "NEW" | "OLD", flags = "0, 0") =>
  `'${spec.tell}', ${at(spec.id, row)}, ${spec.scope === undefined ? "NULL" : at(spec.scope, row)}, '${table}', ${flags}`

const insertTouch = "INSERT INTO told_touches (kind, id, scope, source, renamed, unlisted)"

const flag = (expression: string | undefined) =>
  expression === undefined ? "0" : `(${expression})`

const triggers = (table: string, spec: ToldTable): ReadonlyArray<string> => {
  const columns = spec.columns === undefined ? "" : ` OF ${spec.columns.join(", ")}`
  const compare = spec.compare ?? spec.columns?.map((column) => `{row}.${column}`)
  const when =
    compare === undefined
      ? ""
      : ` WHEN ${compare.map((value) => `${at(value, "OLD")} IS NOT ${at(value, "NEW")}`).join(" OR ")}`
  const flags = `${flag(spec.nameChanged)}, ${flag(spec.unlistedChanged)}`
  const moved =
    spec.scope === undefined
      ? ""
      : ` ${insertTouch} SELECT ${values(table, spec, "OLD")} WHERE ${at(spec.scope, "OLD")} IS NOT ${at(spec.scope, "NEW")};`
  return [
    `CREATE TEMP TRIGGER IF NOT EXISTS told_${table}_insert AFTER INSERT ON main.${table}
      BEGIN ${insertTouch} VALUES (${values(table, spec, "NEW")}); END`,
    `CREATE TEMP TRIGGER IF NOT EXISTS told_${table}_update AFTER UPDATE${columns} ON main.${table}${when}
      BEGIN ${insertTouch} VALUES (${values(table, spec, "NEW", flags)});${moved} END`,
    `CREATE TEMP TRIGGER IF NOT EXISTS told_${table}_delete AFTER DELETE ON main.${table}
      BEGIN ${insertTouch} VALUES (${values(table, spec, "OLD")}); END`
  ]
}

const toldTables = Object.entries(tableTells).flatMap(([table, spec]: [string, TableTell]) =>
  "tell" in spec ? [{ table, spec }] : []
)

const toldSpec = (source: string) => toldTables.find((told) => told.table === source)?.spec

export const scopedSource = (source: string): boolean => toldSpec(source)?.scope !== undefined

export const scopeKind = (source: string): TellKind | undefined => toldSpec(source)?.scopeTells

export const captureStatements: ReadonlyArray<string> = [
  `CREATE TEMP TABLE IF NOT EXISTS told_touches (
    kind TEXT NOT NULL, id TEXT, scope TEXT, source TEXT NOT NULL, renamed INTEGER NOT NULL,
    unlisted INTEGER NOT NULL
  )`,
  ...toldTables.flatMap(({ table, spec }) => triggers(table, spec))
]

export const installCapture = (sql: SqlClient.SqlClient) =>
  Effect.forEach(captureStatements, (statement) => sql.unsafe(statement), { discard: true })

export const touch = (sql: SqlClient.SqlClient, kind: TellKind, id: string) =>
  sql`INSERT INTO temp.told_touches (kind, id, scope, source, renamed, unlisted)
    VALUES (${kind}, ${id}, NULL, 'told', 0, 0)`.pipe(Effect.asVoid)

export const touchedThrough = (sql: SqlClient.SqlClient) =>
  sql<{ readonly seq: number }>`SELECT COALESCE(MAX(rowid), 0) AS seq FROM temp.told_touches`.pipe(
    Effect.map((rows) => rows[0]?.seq ?? 0),
    Effect.orElseSucceed(() => Number.POSITIVE_INFINITY)
  )

export const drainTouches = Effect.fn("Tells.drain")(function* (sql: SqlClient.SqlClient) {
  const touches = yield* sql<Touch>`SELECT rowid AS seq, kind, id, scope, source, renamed, unlisted
    FROM temp.told_touches`
  if (touches.length > 0) yield* sql`DELETE FROM temp.told_touches`
  return touches
})
