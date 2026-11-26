import { DateTime, Effect, Schema } from "effect"
import { WorkStoreError, type WorkStore } from "../work/store.js"
import { runAuthorityState } from "./run-context.js"
import { workError } from "./work-records.js"
import { quietRunOutcome } from "./run-outcomes.js"
import { personRunSql } from "./authority-sql.js"
import type { PersistenceDeps } from "./deps.js"
import { nextOutboxAttemptAt } from "../../runtime/outbox.js"
import { activeRunStatusList, modelTurnRunStatusList } from "./status-sets.js"
import { deliverySourceSql } from "./work-delivery-routing.js"
import { makePendingDeliveries } from "./work-pending-deliveries.js"

export const makeWorkDeliverySql = ({
  writer,
  sessionEvents,
  diagnostics
}: Pick<PersistenceDeps, "writer" | "sessionEvents" | "diagnostics">): Pick<
  WorkStore["Service"],
  "pendingDeliveries" | "discardStoppedResults" | "deferDelivery" | "revokedRuns" | "reportNoChange"
> => {
  const sql = writer.sql
  const reportNoChange: WorkStore["Service"]["reportNoChange"] = Effect.fn(
    function* (runId, reason) {
      const valid = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          runId: Schema.NonEmptyString,
          reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2_000))
        })
      )({ runId, reason }).pipe(
        Effect.mapError((cause) =>
          workError("invalid", "A no-change report requires evidence", cause)
        )
      )
      return yield* writer
        .transact(
          Effect.gen(function* () {
            const rows =
              yield* sql`UPDATE chat_runs SET metadata_json = json_set(metadata_json, '$.no_change_reason', ${valid.reason})
        WHERE run_id = ${valid.runId} AND status IN ${modelTurnRunStatusList}
          AND NOT ${personRunSql(sql, sql`authority_json`)}
        RETURNING run_id`
            if (rows.length === 0)
              return yield* workError("conflict", "Only an active worker can report no change")
            const eligible =
              yield* sql`SELECT 1 FROM chat_runs AS run WHERE run.run_id = ${valid.runId} AND ${quietRunOutcome(sql, "run")}`
            return { quiet: eligible.length > 0 }
          })
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof WorkStoreError
              ? cause
              : workError("storage", "Could not record no-change outcome", cause)
          )
        )
    }
  )
  const pendingDeliveries = makePendingDeliveries({ writer, sessionEvents, diagnostics })
  const discardStoppedResults: WorkStore["Service"]["discardStoppedResults"] = Effect.fn(
    function* (runIds) {
      if (runIds.length === 0) return
      const now = DateTime.formatIso(yield* DateTime.now)
      yield* writer
        .run(
          sql`UPDATE automation_deliveries SET status = 'discarded',
      payload = json_set(payload, '$.settlement', json_object(
        'at', ${now}, 'reason', 'chat_stopped', 'mode', 'discarded'))
      WHERE status = 'pending' AND json_extract(payload, '$.kind') = 'result'
        AND json_extract(payload, '$.runIds[0]') IN ${sql.in(runIds)}
        AND EXISTS (SELECT 1 FROM chat_runs AS run
          WHERE run.run_id = json_extract(payload, '$.runIds[0]') AND run.status = 'cancelled')`
        )
        .pipe(
          Effect.mapError((cause) =>
            workError("storage", "Could not discard the stopped runs' results", cause)
          ),
          Effect.asVoid
        )
    }
  )
  const deferDelivery: WorkStore["Service"]["deferDelivery"] = Effect.fn(
    function* (deliveryId, cause) {
      const valid = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          cause: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
          deliveryId: Schema.NonEmptyString
        })
      )({ cause, deliveryId }).pipe(
        Effect.mapError((error) =>
          workError("invalid", "Delivery retry requires a bounded cause", error)
        )
      )
      const observedAt = yield* DateTime.now
      const current = (yield* sql<{
        readonly attempt_count: number
        readonly destination_session_id: string
        readonly source_run_id: string
      }>`SELECT attempt_count,
        json_extract(payload, '$.sessionId') AS destination_session_id,
        ${deliverySourceSql(sql, sql`payload`)} AS source_run_id
      FROM automation_deliveries
      WHERE delivery_id = ${valid.deliveryId} AND status = 'pending'`.pipe(
        Effect.mapError((error) =>
          workError("storage", "Could not read the arrival retry state", error)
        )
      ))[0]
      if (current === undefined) return
      const attempt = current.attempt_count + 1
      const nextAttemptAt = nextOutboxAttemptAt(DateTime.toEpochMillis(observedAt), attempt)
      const updated = yield* writer
        .run(
          sql`UPDATE automation_deliveries SET
      attempt_count = ${attempt}, next_attempt_at = ${nextAttemptAt}, last_error = ${valid.cause}
      WHERE delivery_id = ${valid.deliveryId} AND status = 'pending'
        AND attempt_count = ${current.attempt_count}
      RETURNING delivery_id`
        )
        .pipe(
          Effect.mapError((error) =>
            workError("storage", "Could not schedule the arrival retry", error)
          )
        )
      if (updated.length === 0) return
      yield* diagnostics.operational({
        code: "delivery.retry_scheduled",
        severity: "warning",
        cause: valid.cause,
        deliveryId: valid.deliveryId,
        sourceRunId: current.source_run_id,
        destinationSessionId: current.destination_session_id,
        attempt,
        nextAttemptAt
      })
    }
  )
  const revokedRuns: WorkStore["Service"]["revokedRuns"] = Effect.fn(function* () {
    return yield* sql<{ readonly runId: string; readonly sessionId: string }>`
      SELECT run.run_id AS runId, run.session_id AS sessionId FROM chat_runs AS run
      WHERE run.status IN ${activeRunStatusList}
        AND (${runAuthorityState(sql, sql`run.metadata_json`, sql`run.run_id`, sql`run.session_id`)} = 'revoked'
          -- Never two chats on one thread: the run that asked stops once the
          -- thread moves, and the target's runs since the move stop once it
          -- comes back (thread-location.ts).
          OR EXISTS (SELECT 1 FROM focus_choices AS choice
            JOIN run_questions AS question ON question.question_id = choice.question_id
            WHERE choice.transitioned_at IS NOT NULL AND run.started_at < choice.transitioned_at
              AND ((choice.decision = 'open_target' AND run.run_id = question.run_id)
                OR (choice.transition = 'brought_back'
                  AND run.session_id = choice.target_session_id
                  AND run.started_at >= choice.settled_at))))
      LIMIT 100
    `.pipe(
      Effect.mapError((cause) => workError("storage", "Could not inspect revoked attempts", cause))
    )
  })
  return {
    pendingDeliveries,
    discardStoppedResults,
    deferDelivery,
    revokedRuns,
    reportNoChange
  }
}
