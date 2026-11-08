import { settledQuestionDrawn, type RunQuestion } from "@arden-hq/protocol/runs"
import type { CommunicationEnvelope } from "@arden-hq/protocol/chat"
import { Clock, DateTime, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { journalRecordsSql } from "@arden-hq/journal/effect"

import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { CommunicationStore, CommunicationStoreError } from "../continuity/store.js"
import { SESSION_LIFECYCLE_STREAM_ID } from "../sessions/events.js"
import { communicationError } from "./continuity-route.js"
import { latestSettledQuestionChanges } from "./question-events.js"
import { writeCommunicationEnvelopeInTransaction } from "./chat-transcript.js"
import { transactWithActiveContext } from "./active-context-stage.js"
import type { PersistenceDeps } from "./deps.js"
import { nextOutboxAttemptAt } from "../../runtime/outbox.js"
import { type CommunicationDeliveryPayload } from "./continuity-payload.js"
import { iso } from "../../runtime/clock.js"
import { canonicalJson } from "@arden-hq/std/json"
import { sha256Hex } from "@arden-hq/std/hash"

interface SeenRow {
  readonly state_version: number
  readonly arrivals_through: number
  readonly question_changes_through: number
  readonly last_acknowledgement_hash: string | null
  readonly acknowledged_at: string | null
}

const decodePayload = (value: string): CommunicationDeliveryPayload => {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Communication delivery payload is not an object")
  }
  return parsed as CommunicationDeliveryPayload
}

const seenState = (row: SeenRow) => ({
  state_version: row.state_version,
  seen_through: {
    arrivals_through: row.arrivals_through,
    question_changes_through: row.question_changes_through
  },
  acknowledged_at: row.acknowledged_at
})

const ensureSeenRow = Effect.fn(function* (sql: SqlClient.SqlClient, spaceId: string) {
  const spaces =
    yield* sql`SELECT 1 FROM spaces WHERE space_id = ${spaceId} AND archived_at IS NULL`
  if (spaces.length === 0) return yield* communicationError("not_found", "Space does not exist")
  yield* sql`INSERT INTO space_continuity_seen(space_id) VALUES(${spaceId}) ON CONFLICT DO NOTHING`
  const rows = yield* sql<SeenRow>`SELECT state_version, arrivals_through, question_changes_through,
      last_acknowledgement_hash, acknowledged_at
    FROM space_continuity_seen WHERE space_id = ${spaceId}`
  const row = rows[0]
  if (row === undefined)
    return yield* communicationError("storage", "Space continuity state is unavailable")
  return row
})

const mapStorage = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, CommunicationStoreError, R> =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof CommunicationStoreError
        ? cause
        : communicationError("storage", "Communication persistence failed", cause)
    )
  )

export const makeCommunicationStore = ({
  writer,
  chatEvents,
  sessionEvents
}: Pick<
  PersistenceDeps,
  "writer" | "chatEvents" | "sessionEvents"
>): CommunicationStore["Service"] => {
  const sql = writer.sql
  const state: CommunicationStore["Service"]["state"] = Effect.fn(function* (spaceId) {
    return yield* mapStorage(
      writer.transact(
        Effect.gen(function* () {
          return { seen: seenState(yield* ensureSeenRow(sql, spaceId)) }
        })
      )
    )
  })

  const acknowledge: CommunicationStore["Service"]["acknowledge"] = Effect.fn(
    function* (spaceId, input) {
      return yield* mapStorage(
        writer.transact(
          Effect.gen(function* () {
            const current = yield* ensureSeenRow(sql, spaceId)
            const acknowledgementHash = sha256Hex(canonicalJson(input))
            if (current.state_version !== input.expected_state_version) {
              if (current.last_acknowledgement_hash === acknowledgementHash)
                return seenState(current)
              return yield* communicationError("conflict", "Space continuity state changed")
            }
            const arrivals = new Set(
              input.rendered.flatMap((record) =>
                record.kind === "arrival" ? [record.arrival_id] : []
              )
            )
            const renderedQuestions = new Map(
              input.rendered.flatMap((record) =>
                record.kind === "question" ? [[record.question_id, record.revision] as const] : []
              )
            )
            let arrivalTarget = current.arrivals_through
            let questionTarget = current.question_changes_through
            for (const record of input.rendered) {
              if (record.kind === "arrival") {
                const rows = yield* sql<{
                  readonly sequence: number
                }>`SELECT communication_sequence AS sequence
            FROM automation_deliveries
            WHERE delivery_id = ${record.arrival_id}
              AND json_extract(payload, '$.kind') = 'communication'
              AND json_extract(payload, '$.visible') = 1
              AND COALESCE(json_extract(payload, '$.shown'), 1) = 1
              AND json_extract(payload, '$.destinationSpaceId') = ${spaceId}`
                if (rows[0] === undefined)
                  return yield* communicationError(
                    "invalid",
                    "Rendered arrival is not in this Space"
                  )
                arrivalTarget = Math.max(arrivalTarget, rows[0].sequence)
              } else {
                const rows = yield* sql<{ readonly destination_space_id: string | null }>`SELECT
              destination.space_id AS destination_space_id
            FROM ${journalRecordsSql(sql)} AS journal
            JOIN run_questions AS question
              ON question.question_id = json_extract(journal.data_json, '$.question_id')
            JOIN sessions AS destination
              ON destination.session_id = json_extract(journal.data_json, '$.session_id')
            WHERE journal.stream_id = ${SESSION_LIFECYCLE_STREAM_ID}
              AND journal.sequence = ${record.revision}
              AND journal.event_type = 'question_changed'
              AND question.question_id = ${record.question_id}`
                const question = rows[0]
                if (question === undefined) {
                  return yield* communicationError(
                    "invalid",
                    "Rendered question revision does not exist"
                  )
                }
                if (question.destination_space_id !== spaceId) {
                  return yield* communicationError(
                    "invalid",
                    "Rendered question is not in this Space"
                  )
                }
                questionTarget = Math.max(questionTarget, record.revision)
              }
            }
            if (
              arrivalTarget <= current.arrivals_through &&
              questionTarget <= current.question_changes_through
            )
              return seenState(current)
            const missingArrivals = yield* sql<{ readonly delivery_id: string }>`SELECT delivery_id
        FROM automation_deliveries
        JOIN space_conversations AS conversation ON conversation.space_id = ${spaceId}
        WHERE communication_sequence > ${current.arrivals_through}
          AND communication_sequence <= ${arrivalTarget}
          AND json_extract(payload, '$.kind') = 'communication'
          AND json_extract(payload, '$.visible') = 1
          AND COALESCE(json_extract(payload, '$.shown'), 1) = 1
          AND json_extract(payload, '$.destinationSpaceId') = ${spaceId}
          AND json_extract(payload, '$.destinationSessionId') = conversation.session_id`
            if (missingArrivals.some((row) => !arrivals.has(row.delivery_id))) {
              return yield* communicationError(
                "conflict",
                "Arrival acknowledgement has a visible gap"
              )
            }
            const settledQuestions = yield* sql<{
              readonly question_id: string
              readonly revision: number
              readonly status: RunQuestion["status"]
            }>`SELECT question_id, revision, status
        FROM (${latestSettledQuestionChanges(sql)}) AS settled
        JOIN space_conversations AS conversation ON conversation.space_id = ${spaceId}
        WHERE revision > ${current.question_changes_through}
          AND revision <= ${questionTarget}
          AND destination_space_id = ${spaceId}
          AND destination_session_id = conversation.session_id`
            if (
              settledQuestions.some(
                (row) =>
                  settledQuestionDrawn(row) &&
                  renderedQuestions.get(row.question_id) !== row.revision
              )
            ) {
              return yield* communicationError(
                "conflict",
                "Question acknowledgement has a visible gap"
              )
            }
            const now = DateTime.formatIso(yield* DateTime.now)
            const rows = yield* sql<SeenRow>`UPDATE space_continuity_seen SET
          state_version = state_version + 1,
          arrivals_through = ${arrivalTarget},
          question_changes_through = ${questionTarget},
          last_acknowledgement_hash = ${acknowledgementHash},
          acknowledged_at = ${now}
        WHERE space_id = ${spaceId} AND state_version = ${input.expected_state_version}
        RETURNING state_version, arrivals_through, question_changes_through, last_acknowledgement_hash, acknowledged_at`
            if (rows[0] === undefined)
              return yield* communicationError("conflict", "Space continuity state changed")
            return seenState(rows[0])
          })
        )
      )
    }
  )

  const pendingDeliveries: CommunicationStore["Service"]["pendingDeliveries"] = Effect.fn(
    function* () {
      const now = iso(yield* Clock.currentTimeMillis)
      const rows = yield* mapStorage(sql<{
        readonly delivery_id: string
        readonly attempt_count: number
      }>`
      SELECT delivery_id, attempt_count
      FROM automation_deliveries
      WHERE status = 'pending' AND json_extract(payload, '$.kind') = 'communication'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
      ORDER BY created_at, delivery_id LIMIT 32`)
      return rows.map((row) => ({ deliveryId: row.delivery_id, attempt: row.attempt_count }))
    }
  )

  const deliverEnvelope: CommunicationStore["Service"]["deliverEnvelope"] = Effect.fn(
    function* (delivery) {
      return yield* mapStorage(
        transactWithActiveContext(
          writer,
          "ordinary",
          {
            lookup: Effect.fn("Communication.deliveryContext")(function* (
              connection: SqlClient.SqlClient
            ) {
              const row = (yield* connection<{ readonly payload: string }>`
              SELECT payload FROM automation_deliveries
              WHERE delivery_id = ${delivery.deliveryId} AND status = 'pending'
            `)[0]
              if (row === undefined) return undefined
              const payload = decodePayload(row.payload)
              return payload.visible && payload.arrival !== undefined
                ? payload.destinationSessionId
                : undefined
            })
          },
          Effect.gen(function* () {
            const row = (yield* sql<{
              readonly payload: string
            }>`SELECT payload FROM automation_deliveries
        WHERE delivery_id = ${delivery.deliveryId} AND status = 'pending'`)[0]
            if (row === undefined) return false
            const payload = decodePayload(row.payload)
            if (!payload.visible || payload.arrival === undefined) {
              const now = iso(yield* Clock.currentTimeMillis)
              yield* sql`UPDATE automation_deliveries SET status = 'delivered',
          delivered_at = COALESCE(delivered_at, ${now})
          WHERE delivery_id = ${delivery.deliveryId} AND status = 'pending'`
              return false
            }
            const envelope: CommunicationEnvelope = {
              kind: "arrival",
              arrival: payload.arrival,
              ...(payload.shown === false ? { shown: false } : {})
            }
            yield* writeCommunicationEnvelopeInTransaction({
              sql,
              sessionEvents,
              sessionId: payload.destinationSessionId,
              messageId: `arrival:${delivery.deliveryId}`,
              envelope,
              createdAt: payload.arrival.occurred_at,
              replace: false
            })
            const updated = yield* sql`UPDATE automation_deliveries SET status = 'delivered',
          delivered_at = ${payload.arrival.occurred_at},
          destinations = ${canonicalJson([`chat:${payload.destinationSessionId}`])},
          next_attempt_at = NULL, last_error = NULL
        WHERE delivery_id = ${delivery.deliveryId} AND status = 'pending'
        RETURNING delivery_id`
            if (updated.length === 0) return false
            yield* chatEvents.appendInTransaction({
              sessionId: payload.destinationSessionId,
              events: [{ event: { type: "transcript_changed" } satisfies ChatProjectionEvent }]
            })
            return true
          })
        )
      )
    }
  )

  const deferDelivery: CommunicationStore["Service"]["deferDelivery"] = Effect.fn(
    function* (delivery, cause) {
      const attempt = delivery.attempt + 1
      const retryAt = nextOutboxAttemptAt(yield* Clock.currentTimeMillis, attempt)
      yield* mapStorage(
        writer.run(sql`UPDATE automation_deliveries SET
      attempt_count = ${attempt}, next_attempt_at = ${retryAt},
      last_error = ${cause}
      WHERE delivery_id = ${delivery.deliveryId} AND status = 'pending'
        AND attempt_count = ${delivery.attempt}`)
      )
    }
  )

  return CommunicationStore.of({
    state,
    acknowledge,
    pendingDeliveries,
    deliverEnvelope,
    deferDelivery
  })
}
