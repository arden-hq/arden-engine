import { Schema } from "effect"
import { journalSqliteSchema } from "@arden-hq/journal/effect"

import { SESSION_OWNED_TABLES } from "../sessions/ownership.js"

const SESSION_SPLIT_TABLES: ReadonlyArray<string> = [
  ...new Set([...SESSION_OWNED_TABLES, "sessions", ...journalSqliteSchema.tables])
]

const sqlName = (name: string): string => `'${name.replaceAll("'", "''")}'`

export const BREAKDOWN_QUERIES = {
  // dbstat constrained by name walks only that object's b-tree, so only the
  // tables outside Session data are measured page by page. Session data is
  // the used pages those tables leave, which also holds SQLite's own schema
  // and pointer-map pages (a few pages per thousand).
  others: `
    SELECT o.tbl_name AS name, SUM(d.pgsize) AS bytes
    FROM sqlite_schema AS o
    JOIN dbstat AS d ON d.name = o.name AND d.aggregate = TRUE
    WHERE o.type IN ('table', 'index')
      AND o.tbl_name NOT IN (${SESSION_SPLIT_TABLES.map(sqlName).join(", ")})
    GROUP BY o.tbl_name
  `,
  size: `
    SELECT page_count * page_size AS bytes, freelist_count * page_size AS free_bytes
    FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()
  `,
  // Both read `session_type_sizes`, one row per kind of chat, kept by triggers.
  weights: `
    SELECT session_type, message_json_bytes AS bytes FROM session_type_sizes WHERE sessions > 0
  `,
  counts: `
    SELECT session_type, sessions AS total, archived FROM session_type_sizes WHERE sessions > 0
  `
} as const

const BreakdownRowsSchema = Schema.Struct({
  others: Schema.Array(Schema.Struct({ name: Schema.String, bytes: Schema.Number })),
  size: Schema.Array(Schema.Struct({ bytes: Schema.Number, free_bytes: Schema.Number })),
  weights: Schema.Array(
    Schema.Struct({ session_type: Schema.String, bytes: Schema.NullOr(Schema.Number) })
  ),
  counts: Schema.Array(
    Schema.Struct({ session_type: Schema.String, total: Schema.Number, archived: Schema.Number })
  )
})

export type BreakdownRows = typeof BreakdownRowsSchema.Type
