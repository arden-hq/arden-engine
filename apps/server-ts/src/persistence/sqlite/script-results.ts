import { DateTime, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

import { workflowDeliveryClientId } from "../chat/workflow-delivery.js"
import {
  MAX_SCRIPT_RESULT_ATTEMPTS,
  ScriptResultError,
  ScriptResultPayloadSchema,
  ScriptResults,
  type ScriptResultDeferral,
  type ScriptResultDelivery
} from "../scripts/results.js"
import { StoredMessageEnvelopeSchema } from "../transcript/model.js"
import { nextOutboxAttemptAt } from "../../runtime/outbox.js"
import type { PersistenceDeps } from "./deps.js"
import { decodeJson } from "./json.js"
import { scriptResultDeliveryId, scriptResultRow, type ScriptResultInput } from "./script-derive.js"

const MAX_ERROR_LENGTH = 2_000

const storage = (message: string) => (cause: unknown) =>
  new ScriptResultError({ reason: "storage", message, cause })

export const insertScriptResult = Effect.fn("ScriptResults.insert")(function* (
  sql: SqlClient.SqlClient,
  input: ScriptResultInput
) {
  const row = scriptResultRow(input)
  const now = DateTime.formatIso(yield* DateTime.now)
  yield* sql`INSERT INTO automation_deliveries (
      delivery_id, task_id, delivered_at, subject, body, payload, status, created_at, destinations
    ) VALUES (
      ${row.deliveryId}, NULL, NULL, 'Script result', ${row.body}, ${JSON.stringify(row.payload)},
      'pending', ${now}, '[]'
    ) ON CONFLICT(delivery_id) DO NOTHING`
})

interface PendingRow {
  readonly delivery_id: string
  readonly body: string
  readonly payload: string
}

export const makeScriptResults = ({
  writer
}: Pick<PersistenceDeps, "writer">): ScriptResults["Service"] => {
  const sql = writer.sql
  const pending = Effect.fn("ScriptResults.pending")(function* (limit: number) {
    const now = DateTime.formatIso(yield* DateTime.now)
    const rows = yield* sql<PendingRow>`
      SELECT delivery.delivery_id, delivery.body, delivery.payload
      FROM automation_deliveries AS delivery
      JOIN sessions AS session
        ON session.session_id = json_extract(delivery.payload, '$.sessionId')
      WHERE delivery.status = 'pending'
        AND json_extract(delivery.payload, '$.kind') = 'script_result'
        AND delivery.attempt_count < ${MAX_SCRIPT_RESULT_ATTEMPTS}
        AND (delivery.next_attempt_at IS NULL OR delivery.next_attempt_at <= ${now})
      ORDER BY delivery.created_at, delivery.delivery_id
      LIMIT ${limit}
    `.pipe(Effect.mapError(storage("Could not load pending script results")))
    return yield* Effect.forEach(rows, (row) =>
      decodeJson(ScriptResultPayloadSchema, row.payload).pipe(
        Effect.map((payload): ScriptResultDelivery => ({
          deliveryId: row.delivery_id,
          body: row.body,
          payload
        })),
        Effect.mapError(
          (cause) =>
            new ScriptResultError({
              reason: "corrupt",
              message: "Stored script result is corrupt",
              cause
            })
        )
      )
    )
  })

  const admitted = Effect.fn("ScriptResults.admitted")(function* (delivery: ScriptResultDelivery) {
    const identity = {
      workflowRef: delivery.payload.workflowRef,
      attempt: delivery.payload.attempt
    }
    const clientId = workflowDeliveryClientId(identity)
    const rows = yield* sql<{ readonly message_json: string }>`
      SELECT message_json FROM chat_idempotency_keys
      WHERE session_id = ${delivery.payload.sessionId} AND client_id = ${clientId}
      LIMIT 1
    `.pipe(Effect.mapError(storage("Could not inspect script result admission")))
    const row = rows[0]
    if (row === undefined) return false
    const message = yield* decodeJson(StoredMessageEnvelopeSchema, row.message_json).pipe(
      Effect.mapError(
        (cause) =>
          new ScriptResultError({
            reason: "corrupt",
            message: "Stored script result admission is corrupt",
            cause
          })
      )
    )
    const stamped = message.workflow_delivery
    if (typeof stamped !== "object" || stamped === null || Array.isArray(stamped)) return false
    return (
      message.is_meta === true &&
      message.message_id === clientId &&
      message.client_id === clientId &&
      "workflow_ref" in stamped &&
      stamped.workflow_ref === identity.workflowRef &&
      "attempt" in stamped &&
      stamped.attempt === identity.attempt
    )
  })

  const markDelivered = Effect.fn("ScriptResults.markDelivered")(function* (deliveryId: string) {
    const now = DateTime.formatIso(yield* DateTime.now)
    yield* writer
      .run(
        sql`UPDATE automation_deliveries SET status = 'delivered', delivered_at = ${now}
          WHERE delivery_id = ${deliveryId} AND status = 'pending'`
      )
      .pipe(Effect.mapError(storage("Could not mark a script result delivered")))
  })

  const defer = Effect.fn("ScriptResults.defer")(function* (input: {
    readonly deliveryId: string
    readonly error: string
  }) {
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now)
          const rows = yield* sql<{ readonly attempt_count: number }>`
            SELECT attempt_count FROM automation_deliveries
            WHERE delivery_id = ${input.deliveryId} AND status = 'pending'
          `
          const attempts = (rows[0]?.attempt_count ?? 0) + 1
          const deferral: ScriptResultDeferral =
            attempts >= MAX_SCRIPT_RESULT_ATTEMPTS
              ? { kind: "abandoned", attempts }
              : {
                  kind: "retrying",
                  attempts,
                  nextAttemptAt: nextOutboxAttemptAt(Date.parse(now), attempts)
                }
          yield* sql`UPDATE automation_deliveries SET attempt_count = ${attempts},
              next_attempt_at = ${deferral.kind === "retrying" ? deferral.nextAttemptAt : null},
              last_error = ${input.error.slice(0, MAX_ERROR_LENGTH)}
            WHERE delivery_id = ${input.deliveryId} AND status = 'pending'`
          return deferral
        })
      )
      .pipe(Effect.mapError(storage("Could not record a failed script result delivery")))
  })

  const text: ScriptResults["Service"]["text"] = (script) =>
    sql<{ readonly body: string }>`
      SELECT body FROM automation_deliveries
      WHERE delivery_id = ${scriptResultDeliveryId(script)}
    `.pipe(
      Effect.map((rows) => rows[0]?.body),
      Effect.mapError(storage("Could not read a script result"))
    )

  return ScriptResults.of({ pending, admitted, markDelivered, text, defer })
}
