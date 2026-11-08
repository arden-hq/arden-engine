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
  weights: `
    SELECT s.session_type, SUM((
      SELECT SUM(octet_length(m.message_json))
      FROM session_messages AS m WHERE m.session_id = s.session_id
    )) AS bytes
    FROM sessions AS s GROUP BY s.session_type
  `,
  counts: `
    SELECT session_type, COUNT(*) AS total, SUM(archived_at IS NOT NULL) AS archived
    FROM sessions GROUP BY session_type
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
