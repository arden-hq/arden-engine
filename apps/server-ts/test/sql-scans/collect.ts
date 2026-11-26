import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { GROWING_TABLES } from "./growing-tables.js"

export interface TableScan {
  readonly id: string
  readonly table: string
  readonly detail: string
  readonly sql: string
}

interface LoggedScan {
  readonly name: string
  readonly table?: string
  readonly index?: string
  readonly partial: boolean
  readonly detail: string
  readonly sql: string
}

const NOT_AN_ALIAS = new Set([
  "as",
  "on",
  "where",
  "set",
  "left",
  "right",
  "inner",
  "outer",
  "cross",
  "natural",
  "join",
  "order",
  "group",
  "limit",
  "using",
  "indexed",
  "not",
  "union",
  "values",
  "select",
  "having",
  "window",
  "returning",
  "except",
  "intersect"
])

const aliases = (sql: string): Map<string, string> => {
  const found = new Map<string, string>()
  const pattern =
    /\b(?:from|join|update|into)\s+"?([a-z_][\w]*)"?(?:\s+(?:as\s+)?"?([a-z_]\w*)"?)?/gi
  for (const match of sql.matchAll(pattern)) {
    const table = match[1]?.toLowerCase()
    const alias = match[2]?.toLowerCase()
    if (table === undefined) continue
    found.set(table, table)
    if (alias !== undefined && !NOT_AN_ALIAS.has(alias)) found.set(alias, table)
  }
  return found
}

const shape = (sql: string): string =>
  sql
    .replace(/\s+/g, " ")
    .replace(/\?(?:\s*,\s*\?)+/g, "?")
    .trim()

const scanId = (sql: string): string =>
  createHash("sha256").update(shape(sql)).digest("hex").slice(0, 12)

export const collectTableScans = (directory: string): ReadonlyArray<TableScan> => {
  const scans = new Map<string, TableScan>()
  if (!existsSync(directory)) return []
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".jsonl")) continue
    for (const line of readFileSync(join(directory, file), "utf8").split("\n")) {
      if (line.length === 0) continue
      const logged = JSON.parse(line) as LoggedScan
      if (logged.partial) continue
      const name = logged.name.toLowerCase().replace(/^main\./, "")
      const table = logged.table ?? aliases(logged.sql).get(name) ?? name
      if (table === undefined || !GROWING_TABLES.has(table)) continue
      const id = scanId(logged.sql)
      scans.set(`${id}:${table}`, { id, table, detail: logged.detail, sql: shape(logged.sql) })
    }
  }
  return [...scans.values()].toSorted(
    (a, b) => a.table.localeCompare(b.table) || a.id.localeCompare(b.id)
  )
}
