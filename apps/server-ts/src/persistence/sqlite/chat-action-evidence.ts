import { Effect, Option, Predicate, Schema } from "effect"
import type { SqlError } from "effect/unstable/sql"
import type { SqlClient } from "effect/unstable/sql"
import type { ChatActionRetirementSource } from "@arden-hq/protocol/proposals"
import { engineOrderedJson } from "@arden-hq/std/json"
import { JsonObjectSchema } from "../json.js"
import { mutationOperationId, readMutationReceipt } from "../tools/mutation-receipt.js"
import type {
  SessionToolEvidenceInput,
  SessionToolEvidencePage
} from "../sessions/tool-evidence.js"
import { decodeJson, type JsonColumnError } from "./json.js"
import { PersistedToolResultSchema } from "./tool-rows.js"
import { sha256Hex } from "@arden-hq/std/hash"

export interface ChatToolEvidenceRow {
  readonly cursor: number
  readonly session_id: string
  readonly turn_id: string | null
  readonly run_id: string
  readonly tool_call_id: string
  readonly tool_name: string
  readonly arguments_json: string
  readonly result_json: string | null
  readonly changes_state: number
  readonly status: string
  readonly effect: string | null
  readonly started_at: string
  readonly ended_at: string | null
}

export const readSessionToolEvidence = Effect.fn("Session.toolEvidence")(function* (
  sql: SqlClient.SqlClient,
  input: SessionToolEvidenceInput
): Effect.fn.Return<SessionToolEvidencePage, JsonColumnError | SqlError.SqlError> {
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit)))
  const offset = Math.max(0, Math.trunc(input.contentOffset ?? 0))
  const maxChars = Math.max(1, Math.trunc(input.contentChars ?? 400))
  const rows = yield* sql<ChatToolEvidenceRow>`SELECT call.rowid AS cursor, call.*,
    json_extract(run.metadata_json, '$.turn_id') AS turn_id
    FROM tool_calls AS call JOIN chat_runs AS run
      ON run.run_id = call.run_id AND run.session_id = call.session_id
    WHERE call.session_id = ${input.sessionId}
      AND (${input.turnId ?? null} IS NULL OR json_extract(run.metadata_json, '$.turn_id') = ${input.turnId ?? null})
      AND call.rowid < ${input.before ?? Number.MAX_SAFE_INTEGER}
    ORDER BY call.rowid DESC LIMIT ${limit + 1}`
  const items = yield* Effect.forEach(
    rows.slice(0, limit),
    Effect.fn("Session.toolEvidenceItem")(function* (row: ChatToolEvidenceRow) {
      const evidence = yield* decodeChatToolEvidence(row)
      const payload = engineOrderedJson({ arguments: evidence.arguments, result: evidence.result })
      return {
        cursor: row.cursor,
        turn_id: row.turn_id,
        tool_call_id: row.tool_call_id,
        tool_name: row.tool_name,
        status: row.status,
        changes_state: row.changes_state === 1,
        source: evidence.source,
        payload: {
          text: payload.slice(offset, offset + maxChars),
          total_chars: payload.length,
          next_offset: offset + maxChars < payload.length ? offset + maxChars : undefined
        }
      }
    })
  )
  return { items, next_before: rows.length > limit ? items.at(-1)?.cursor : undefined }
})

export const decodeChatToolEvidence = Effect.fn("Chat.decodeToolEvidence")(function* (
  row: ChatToolEvidenceRow
) {
  const arguments_ = yield* decodeJson(JsonObjectSchema, row.arguments_json).pipe(
    Effect.orElseSucceed(() => row.arguments_json)
  )
  const rawResult =
    row.result_json === null
      ? null
      : yield* decodeJson(Schema.Json, row.result_json).pipe(
          Effect.orElseSucceed(() => row.result_json)
        )
  const result: unknown =
    Predicate.isObject(rawResult) &&
    Predicate.isObject(rawResult.data) &&
    !Array.isArray(rawResult.data)
      ? {
          ...Object.fromEntries(Object.entries(rawResult)),
          data: Object.fromEntries(
            Object.entries(rawResult.data).filter(([key]) => key !== "approval")
          )
        }
      : rawResult
  const revision = sha256Hex(
    engineOrderedJson({
      session_id: row.session_id,
      turn_id: row.turn_id,
      run_id: row.run_id,
      tool_call_id: row.tool_call_id,
      tool_name: row.tool_name,
      arguments: arguments_,
      result,
      changes_state: row.changes_state,
      status: row.status,
      effect: row.effect,
      started_at: row.started_at,
      ended_at: row.ended_at
    })
  )
  const receipt = readMutationReceipt(Predicate.isObject(result) ? result.host : undefined)
  const operationId = mutationOperationId({ runId: row.run_id, toolCallId: row.tool_call_id })
  const validResult = Option.getOrUndefined(
    Schema.decodeUnknownOption(PersistedToolResultSchema)(result)
  )
  const source: ChatActionRetirementSource | undefined =
    row.status === "completed" &&
    row.changes_state === 1 &&
    Predicate.isObject(arguments_) &&
    row.ended_at !== null &&
    row.turn_id !== null &&
    row.turn_id.length > 0 &&
    validResult !== undefined &&
    validResult.is_error !== true &&
    receipt?.outcome === "applied" &&
    receipt.operation_id === operationId &&
    receipt.receipt_ref === operationId
      ? {
          kind: "chat_action",
          session_id: row.session_id,
          turn_id: row.turn_id,
          run_id: row.run_id,
          tool_call_id: row.tool_call_id,
          revision
        }
      : undefined
  return { arguments: arguments_, result, revision, receipt, source }
})
