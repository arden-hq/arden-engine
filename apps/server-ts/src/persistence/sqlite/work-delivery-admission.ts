import { UPDATE_WEIGHT } from "@arden-hq/protocol/chat"
import { DateTime, Effect } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import {
  RUN_DELIVERY_KIND,
  RunDeliveryPayloadSchema,
  type RunDeliveryPayload
} from "../deliveries/model.js"
import type { SqlClient } from "effect/unstable/sql"
import { decodeJson } from "./json.js"
import { captureRunTask } from "./run-context.js"
import { workError } from "./work-records.js"
import { activeRunStatusList, stoppedRunSql } from "./status-sets.js"
import { liftChat } from "./session-unread.js"
import type { SessionLifecycleEventError } from "../sessions/events.js"
import type { UnitOfWork } from "../unit-of-work.js"
import {
  turnDeliveryKindSql,
  awaitsSiblingAgents,
  steersRun,
  threadDeliveryOwner,
  arrivalText
} from "./work-delivery-routing.js"

export const readDeliveryForAdmission = Effect.fn(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly deliveryId: string
  readonly sessionId: string
  readonly admittedWith: ReadonlyArray<string>
  readonly content: unknown
}) {
  const content = arrivalText(options.content)
  const rows = yield* options.sql<{
    readonly payload: string
    readonly body: string
    readonly created_at: string
  }>`
    SELECT payload, body, created_at FROM automation_deliveries
    WHERE delivery_id = ${options.deliveryId} AND status = 'pending' AND payload IS NOT NULL
      AND ${turnDeliveryKindSql(options.sql, options.sql`payload`)}
  `.pipe(
    Effect.mapError((cause) => workError("storage", "Could not read arrival authority", cause))
  )
  const row = rows[0]
  if (!row) return yield* workError("conflict", "Arrival is no longer pending")
  const payload = yield* decodeJson(RunDeliveryPayloadSchema, row.payload).pipe(
    Effect.mapError((cause) => workError("storage", "Stored arrival is corrupt", cause))
  )
  if (payload.sessionId !== options.sessionId || row.body !== content)
    return yield* workError("invalid", "Arrival destination or content changed")
  if (payload.kind === RUN_DELIVERY_KIND.thread) yield* threadDeliveryOwner(options.sql, payload)
  if (payload.kind !== RUN_DELIVERY_KIND.update && payload.timeout === true) {
    const stopped = yield* options.sql`SELECT 1 FROM chat_runs WHERE run_id = ${payload.runIds[0]}
      AND ${stoppedRunSql()}`
    if (stopped.length > 0) return yield* workError("conflict", "The asking run was stopped")
  }
  if (payload.kind === RUN_DELIVERY_KIND.answer && payload.context.task) {
    const current = yield* captureRunTask({
      sql: options.sql,
      itemId: payload.context.task.item_id
    })
    if (current?.generation !== payload.context.task.generation) {
      return yield* workError("conflict", "The question's Task attempt no longer has authority")
    }
  }
  const active = yield* options.sql`SELECT 1 FROM chat_runs WHERE session_id = ${options.sessionId}
    AND status IN ${activeRunStatusList}
    AND (status = 'pending' OR NOT (${steersRun(options.sql, row.payload, options.sql`chat_runs.run_id`)}))
    ${
      options.admittedWith.length === 0
        ? options.sql``
        : options.sql`AND (client_id IS NULL OR client_id NOT IN ${options.sql.in(options.admittedWith)})`
    } LIMIT 1`.pipe(
    Effect.mapError((cause) => workError("storage", "Could not inspect arrival destination", cause))
  )
  if (active.length > 0)
    return yield* workError("conflict", "Arrival waits for the current Chat turn")
  const now = DateTime.formatIso(yield* DateTime.now)
  const siblings = yield* options.sql`SELECT 1 WHERE ${awaitsSiblingAgents(
    options.sql,
    row.payload,
    row.created_at,
    now
  )}`.pipe(
    Effect.mapError((cause) => workError("storage", "Could not inspect sibling agents", cause))
  )
  if (siblings.length > 0)
    return yield* workError("conflict", "Arrival waits for the other agents to report")
  const approvals = yield* options.sql`SELECT 1 FROM tool_approvals
    WHERE session_id = ${options.sessionId} AND status = 'pending' LIMIT 1`.pipe(
    Effect.mapError((cause) => workError("storage", "Could not inspect pending approvals", cause))
  )
  if (approvals.length > 0)
    return yield* workError("conflict", "Arrival waits for the pending approval")
  return payload
})

export const liftOwedUpdate = (
  sql: SqlClient.SqlClient,
  sessionEvents: Parameters<typeof liftChat>[1],
  delivery: RunDeliveryPayload | undefined,
  at: string
): Effect.Effect<void, SqlError | SessionLifecycleEventError, UnitOfWork> =>
  delivery?.kind === RUN_DELIVERY_KIND.update && delivery.update.weight === UPDATE_WEIGHT.owed
    ? liftChat(sql, sessionEvents, { sessionId: delivery.sessionId, at })
    : Effect.void
