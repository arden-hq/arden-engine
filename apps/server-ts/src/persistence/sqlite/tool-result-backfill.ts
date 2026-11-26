import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"

import { ToolResultObjects } from "../managed-output/tool-result-objects.js"
import type { PreparedBackfill } from "./backfills/backfill.js"
import { scriptProgressBackfill } from "./script-executions.js"
import { spaceWordsBackfill } from "./space-words-backfill.js"
import {
  PersistedToolResultSchema,
  publishLargeToolResult,
  STORED_RESULT_INLINE_BYTES,
  storedResultJson
} from "./tool-result-storage.js"

const AFTER: ReadonlyArray<string> = [scriptProgressBackfill.name, spaceWordsBackfill.name]

const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(PersistedToolResultSchema))

interface LargeRow {
  readonly row_key: number
  readonly session_id: string
  readonly tool_name: string
  readonly tool_call_id: string
  readonly result_json: string
}

const swapRows = Effect.fn("ToolResults.slimBackfillSwap")(function* (
  swaps: ReadonlyArray<{ readonly rowKey: number; readonly from: string; readonly to: string }>
) {
  const sql = yield* SqlClient.SqlClient
  let converted = 0
  for (const swap of swaps) {
    const changed = yield* sql`
      UPDATE tool_calls SET result_json = ${swap.to}
      WHERE rowid = ${swap.rowKey} AND result_json = ${swap.from}
      RETURNING rowid`
    converted += changed.length
  }
  return converted
})

export const slimToolResultsBackfill: PreparedBackfill = {
  name: "slim_tool_results",
  landed: "2026-11-13",
  prepare: Effect.fn("ToolResults.slimBackfillPrepare")(function* ({ cursor, limit, reader }) {
    if ((yield* ToolResultObjects) === undefined)
      return Effect.succeed({ converted: 0, next: undefined })
    const finished = yield* reader<{ readonly name: string }>`
      SELECT name FROM data_backfills
      WHERE name IN ${reader.in(AFTER)} AND finished_at IS NOT NULL`
    if (finished.length < AFTER.length)
      return yield* Effect.fail(
        new Error(`Tool results are slimmed after the ${AFTER.join(" and ")} backfills`)
      )
    const after = cursor === undefined ? 0 : Number(cursor)
    const rows = yield* reader<LargeRow>`
      SELECT rowid AS row_key, session_id, tool_name, tool_call_id, result_json FROM tool_calls
      WHERE rowid > ${after} AND octet_length(result_json) > ${STORED_RESULT_INLINE_BYTES}
        AND json_type(result_json, '$.stored_result') IS NULL
      ORDER BY rowid LIMIT ${limit}`
    const swaps: Array<{ readonly rowKey: number; readonly from: string; readonly to: string }> = []
    for (const row of rows) {
      const result = Option.getOrUndefined(decodeResult(row.result_json))
      if (result === undefined) continue
      const published = yield* publishLargeToolResult(
        { sessionId: row.session_id, toolName: row.tool_name, toolCallId: row.tool_call_id },
        result
      )
      if (published === undefined) continue
      swaps.push({
        rowKey: row.row_key,
        from: row.result_json,
        to: yield* storedResultJson(result, published)
      })
    }
    const last = rows.at(-1)
    const next = rows.length < limit || last === undefined ? undefined : String(last.row_key)
    return swapRows(swaps).pipe(Effect.map((converted) => ({ converted, next })))
  }),
  remaining: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const state = yield* sql<{ readonly cursor: string | null }>`
      SELECT cursor FROM data_backfills WHERE name = 'slim_tool_results'`
    const top = yield* sql<{
      readonly top: number | null
    }>`SELECT max(rowid) AS top FROM tool_calls`
    return Math.max(0, (top[0]?.top ?? 0) - Number(state[0]?.cursor ?? 0))
  })
}
