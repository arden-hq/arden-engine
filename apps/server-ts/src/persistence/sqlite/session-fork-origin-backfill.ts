import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SessionForkOriginSchema } from "@arden-hq/protocol/effect/common"
import type { Backfill } from "./backfills/backfill.js"
import { decodeJson } from "./json.js"
import { JsonObjectSchema } from "../json.js"

const LegacyForkSchema = Schema.Struct({
  source_session_id: Schema.NonEmptyString,
  through_sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1))
})

export const sessionForkOriginBackfill: Backfill = {
  name: "session_fork_origin",
  chunk: Effect.fn("SessionForkOrigin.backfillChunk")(function* ({ cursor, limit }) {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      readonly session_id: string
      readonly started_at: string
      readonly metadata: string | null
    }>`SELECT session_id, started_at, metadata FROM sessions
       WHERE session_id > ${cursor ?? ""}
         AND CASE WHEN json_valid(metadata) THEN json_type(metadata, '$.fork_of') = 'object'
           AND json_type(metadata, '$.fork_of.source_session_id') = 'text'
           AND length(json_extract(metadata, '$.fork_of.source_session_id')) > 0
           AND json_type(metadata, '$.fork_of.through_sequence') = 'integer'
           AND CAST(json_extract(metadata, '$.fork_of.through_sequence') AS INTEGER) >= -1
           ELSE 0 END
       ORDER BY session_id LIMIT ${limit}`
    let converted = 0
    for (const row of rows) {
      const decoded = yield* decodeJson(JsonObjectSchema, row.metadata ?? "{}").pipe(Effect.option)
      if (decoded._tag === "None") continue
      const current = Schema.decodeUnknownOption(SessionForkOriginSchema)(decoded.value.fork_origin)
      if (current._tag === "Some") {
        yield* sql`UPDATE sessions SET metadata = json_remove(metadata, '$.fork_of')
          WHERE session_id = ${row.session_id}`
        converted += 1
        continue
      }
      const legacy = Schema.decodeUnknownOption(LegacyForkSchema)(decoded.value.fork_of)
      if (legacy._tag === "None") continue
      const source = yield* sql<{
        readonly public_ref: string | null
        readonly message_id: string | null
      }>`SELECT (SELECT public_ref FROM sessions WHERE session_id = ${legacy.value.source_session_id}) AS public_ref,
            (SELECT message_id FROM session_messages
              WHERE session_id = ${legacy.value.source_session_id}
                AND seq = ${legacy.value.through_sequence}) AS message_id`
      const origin = Schema.decodeUnknownOption(SessionForkOriginSchema)({
        sourceSessionId: legacy.value.source_session_id,
        sourceSessionRef: source[0]?.public_ref ?? null,
        throughSequence: legacy.value.through_sequence,
        sourceMessageId: source[0]?.message_id ?? null,
        createdAt: row.started_at
      })
      if (origin._tag === "None") continue
      yield* sql`UPDATE sessions
        SET metadata = json_set(json_remove(COALESCE(metadata, '{}'), '$.fork_of'),
          '$.fork_origin', json(${JSON.stringify(origin.value)}))
        WHERE session_id = ${row.session_id}
          AND CASE WHEN json_valid(metadata) THEN json_type(metadata, '$.fork_of') = 'object' ELSE 0 END`
      converted += 1
    }
    const last = rows.at(-1)
    return {
      converted,
      next: last === undefined ? undefined : String(last.session_id)
    }
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM sessions
      WHERE CASE WHEN json_valid(metadata) THEN json_type(metadata, '$.fork_of') = 'object'
        AND json_type(metadata, '$.fork_of.source_session_id') = 'text'
        AND length(json_extract(metadata, '$.fork_of.source_session_id')) > 0
        AND json_type(metadata, '$.fork_of.through_sequence') = 'integer'
        AND CAST(json_extract(metadata, '$.fork_of.through_sequence') AS INTEGER) >= -1
        ELSE 0 END`
    return rows[0]?.count ?? 0
  })
}
