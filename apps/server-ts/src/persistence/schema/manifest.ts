import { DatabaseSync } from "node:sqlite"
import { databaseSchema } from "./database.js"
import { sha256Hex } from "@arden-hq/std/hash"

export interface SchemaManifestRow {
  readonly type: string
  readonly name: string
  readonly tbl_name: string
  readonly sql: string | null
}

export type SchemaManifestVerdict =
  | {
      readonly kind: "current"
      readonly foreign: ReadonlyArray<SchemaManifestRow>
    }
  | {
      readonly kind: "conversion_required"
      readonly missing: ReadonlyArray<SchemaManifestRow>
      readonly foreign: ReadonlyArray<SchemaManifestRow>
    }
  | {
      readonly kind: "incompatible"
      readonly problems: ReadonlyArray<string>
      readonly foreign: ReadonlyArray<SchemaManifestRow>
    }

export const schemaIdentity = (row: Pick<SchemaManifestRow, "type" | "name">): string =>
  `${row.type}:${row.name}`

export const schemaManifestFingerprint = (rows: ReadonlyArray<SchemaManifestRow>): string =>
  sha256Hex(JSON.stringify(rows))

export const readSchemaManifest = (database: DatabaseSync): ReadonlyArray<SchemaManifestRow> =>
  database
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name`
    )
    .all()
    .map((row) => ({
      type: String(row.type),
      name: String(row.name),
      tbl_name: String(row.tbl_name),
      sql: typeof row.sql === "string" ? row.sql : null
    }))

export const readForeignTableReferences = (
  database: DatabaseSync,
  referenceRows: ReadonlyArray<SchemaManifestRow>,
  liveRows: ReadonlyArray<SchemaManifestRow>
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const reference = new Set(referenceRows.map(schemaIdentity))
  const tables = liveRows.filter(
    (row) => row.type === "table" && !reference.has(schemaIdentity(row))
  )
  return new Map(
    tables.map((row) => [
      row.name,
      database
        .prepare('SELECT "table" AS target FROM pragma_foreign_key_list(?) ORDER BY id, seq')
        .all(row.name)
        .map((reference) => String(reference.target))
    ])
  )
}

export const manifestOf = (statements: ReadonlyArray<string>): ReadonlyArray<SchemaManifestRow> => {
  const database = new DatabaseSync(":memory:")
  try {
    for (const statement of statements) database.exec(statement)
    return readSchemaManifest(database)
  } finally {
    database.close()
  }
}

export const buildReferenceSchemaManifest = (): ReadonlyArray<SchemaManifestRow> => {
  const rows = manifestOf(databaseSchema.statements)
  const declared = [
    ...databaseSchema.tables.map((name) => `table:${name}`),
    ...databaseSchema.indexes.map((name) => `index:${name}`),
    ...databaseSchema.triggers.map((name) => `trigger:${name}`)
  ]
  const declaredSet = new Set(declared)
  const referenceSet = new Set(rows.map(schemaIdentity))
  const missing = declared.filter((identity) => !referenceSet.has(identity))
  const unexpected = [...referenceSet].filter((identity) => !declaredSet.has(identity))
  if (
    declaredSet.size !== declared.length ||
    referenceSet.size !== rows.length ||
    missing.length > 0 ||
    unexpected.length > 0
  ) {
    throw new Error(
      [
        "Current SQLite schema declarations do not match their generated manifest",
        ...(missing.length === 0 ? [] : [`missing: ${missing.join(", ")}`]),
        ...(unexpected.length === 0 ? [] : [`unexpected: ${unexpected.join(", ")}`])
      ].join("; ")
    )
  }
  return rows
}

export const classifySchemaManifest = (
  referenceRows: ReadonlyArray<SchemaManifestRow>,
  liveRows: ReadonlyArray<SchemaManifestRow>,
  foreignTableReferences: ReadonlyMap<string, ReadonlyArray<string>> = new Map()
): SchemaManifestVerdict => {
  const reference = new Map(referenceRows.map((row) => [schemaIdentity(row), row]))
  const live = new Map(liveRows.map((row) => [schemaIdentity(row), row]))
  const problems: Array<string> = []
  if (live.size !== liveRows.length) problems.push("duplicate live object identities")

  for (const [identity, expected] of reference) {
    const actual = live.get(identity)
    if (actual === undefined) continue
    if (actual.tbl_name !== expected.tbl_name) {
      problems.push(`${identity} has a different owner`)
    } else if (actual.sql !== expected.sql) {
      problems.push(`${identity} is not the current baseline`)
    }
  }

  const ownedNames = new Set(referenceRows.map((row) => row.name))
  const unexpected = liveRows.filter((row) => !reference.has(schemaIdentity(row)))
  const detachedForeignTableNames = new Set(
    unexpected
      .filter(
        (row) =>
          row.type === "table" &&
          !ownedNames.has(row.name) &&
          foreignTableReferences.has(row.name) &&
          foreignTableReferences.get(row.name)?.length === 0
      )
      .map((row) => row.name)
  )
  const foreign: Array<SchemaManifestRow> = []
  for (const row of unexpected) {
    const identity = schemaIdentity(row)
    if (ownedNames.has(row.name)) {
      problems.push(`${identity} collides with an owned schema object`)
      continue
    }
    if (row.type === "table" && detachedForeignTableNames.has(row.name)) {
      foreign.push(row)
      continue
    }
    if (row.type === "index" && detachedForeignTableNames.has(row.tbl_name)) {
      foreign.push(row)
      continue
    }
    problems.push(`${identity} can interfere with owned schema`)
  }

  if (problems.length > 0) return { kind: "incompatible", problems, foreign }
  const missing = referenceRows.filter((row) => !live.has(schemaIdentity(row)))
  return missing.length === 0
    ? { kind: "current", foreign }
    : { kind: "conversion_required", missing, foreign }
}
