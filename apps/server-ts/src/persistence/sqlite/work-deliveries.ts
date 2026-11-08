import { DateTime, Effect, Schema } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { RunDelivery } from "../deliveries/model.js"
import type { SqlClient, Statement } from "effect/unstable/sql"
import { RunDeliveryPayloadSchema, type RunDeliveryPayload } from "../deliveries/model.js"
import { WorkStoreError, type WorkStore } from "../work/store.js"
import { decodeJson } from "./json.js"
import { userContent } from "../transcript/user-content.js"
import { executionBudgetExpired } from "./execution-budgets.js"
import { captureRunTask, runAuthorityState } from "./run-context.js"
import { workError } from "./work-records.js"
import { quietRunOutcome } from "./run-outcomes.js"
import { personRunSql, takesAnswersMidRunSql } from "./authority-sql.js"
import { appendQuestionChange } from "./question-events.js"
import type { OperationalEventInput } from "../../runtime/operational-events.js"
import type { PersistenceDeps } from "./deps.js"
import { nextOutboxAttemptAt } from "../../runtime/outbox.js"
import {
  activeRunStatusList,
  modelTurnRunStatusList,
  stoppedRunSql,
  terminalRunStatusList
} from "./status-sets.js"
import { iso } from "../../runtime/clock.js"
import { taskOpenSql } from "./task-status-sql.js"
import { userChatSql } from "./chat-ownership.js"
import { sessionAncestors } from "./tree-walk.js"
import { liftChat } from "./session-unread.js"
import { parentCompletion } from "../runs/parent-completion.js"
import type { EndingRecord } from "../runs/ending.js"
import type { ChatRunRecord } from "../runs/model.js"
import { doorRef } from "../transcript/chat-events.js"
import type { Interaction } from "@arden-hq/loop"
import type { ChatUpdate } from "@arden-hq/protocol/chat"
import { sha256Hex } from "@arden-hq/std/hash"

const unroutableSummary =
  "A worker result could not be delivered because no visible parent conversation remains."

const TURN_DELIVERY_KINDS: ReadonlyArray<RunDeliveryPayload["kind"]> = [
  "answer",
  "result",
  "thread",
  "connection",
  "update"
]

const turnDeliveryKindSql = (sql: SqlClient.SqlClient, payload: Statement.Fragment) =>
  sql`json_extract(${payload}, '$.kind') IN ${sql.in(TURN_DELIVERY_KINDS)}`

const deliverySourceSql = (sql: SqlClient.SqlClient, payload: Statement.Fragment) =>
  sql`COALESCE(json_extract(${payload}, '$.runIds[0]'), json_extract(${payload}, '$.source.runId'),
    json_extract(${payload}, '$.source.key'))`

const childAgentResult = (sql: SqlClient.SqlClient, payload: string | Statement.Fragment) => sql`
  json_extract(${payload}, '$.kind') = 'result'
  AND EXISTS (SELECT 1 FROM chat_runs AS child_run
    JOIN sessions AS child ON child.session_id = child_run.session_id
    WHERE child_run.run_id = json_extract(${payload}, '$.runIds[0]')
      AND child.session_type = 'agent'
      AND child.parent_session_id = json_extract(${payload}, '$.sessionId'))`

const SIBLING_HOLD_MS = 10 * 60_000

const awaitsSiblingAgents = (
  sql: SqlClient.SqlClient,
  payload: string | Statement.Fragment,
  createdAt: string | Statement.Fragment,
  now: string
) => sql`
  (${childAgentResult(sql, payload)})
  AND ${createdAt} > ${iso(Date.parse(now) - SIBLING_HOLD_MS)}
  AND EXISTS (SELECT 1 FROM sessions AS sibling
    JOIN chat_runs AS sibling_run ON sibling_run.session_id = sibling.session_id
    WHERE sibling.parent_session_id = json_extract(${payload}, '$.sessionId')
      AND sibling.session_type = 'agent'
      AND sibling.archived_at IS NULL
      AND sibling_run.status IN ${activeRunStatusList}
      AND sibling_run.run_id <> json_extract(${payload}, '$.runIds[0]'))`

const answerToAskingRun = (
  sql: SqlClient.SqlClient,
  payload: string | Statement.Fragment,
  runId: Statement.Fragment
) => sql`
  json_extract(${payload}, '$.kind') = 'answer'
  AND ${runId} = json_extract(${payload}, '$.runIds[0]')
  AND EXISTS (SELECT 1 FROM chat_runs AS asking
    JOIN sessions AS asking_chat ON asking_chat.session_id = asking.session_id
    WHERE asking.run_id = ${runId}
      AND (json_extract(${payload}, '$.timeout') = 1 OR ${takesAnswersMidRunSql(sql, sql`asking.authority_json`, sql`asking_chat.session_type = 'agent'`)}))`

const steersRun = (
  sql: SqlClient.SqlClient,
  payload: string | Statement.Fragment,
  runId: Statement.Fragment
) => sql`(${childAgentResult(sql, payload)}) OR (${answerToAskingRun(sql, payload, runId)})`

const updateInteraction = (
  payload: Extract<RunDeliveryPayload, { readonly kind: "update" }>,
  body: string
): Interaction => ({
  kind: "completion",
  from: {
    type: "agent",
    id: doorRef(payload.update.door, null),
    display_name: payload.update.door.label
  },
  to: { type: "agent", id: payload.sessionId },
  content: body,
  outcome: updateOutcome(payload.update)
})

const updateOutcome = (
  update: ChatUpdate
): Extract<Interaction, { readonly kind: "completion" }>["outcome"] => {
  if (update.weight === "news") return "completed"
  return update.event === "failed" ? "failed" : "needs_attention"
}

const threadDeliveryOwner = Effect.fn("WorkDeliveries.threadOwner")(function* (
  sql: SqlClient.SqlClient,
  payload: Extract<RunDeliveryPayload, { readonly kind: "thread" }>
) {
  const rows = yield* sql<{
    readonly source_ref: string
    readonly source_name: string | null
    readonly target_ref: string
  }>`SELECT source.public_ref AS source_ref, source.name AS source_name,
      target.public_ref AS target_ref
    FROM focus_choices AS choice
    JOIN sessions AS source ON source.session_id = choice.source_session_id
    JOIN sessions AS target ON target.session_id = choice.result_session_id
    WHERE choice.question_id = ${payload.questionId}
      AND choice.decision = 'open_target'
      AND choice.result_session_id = ${payload.sessionId}
      AND choice.revision = ${payload.revision}`
  const owner = rows[0]
  if (owner === undefined)
    return yield* workError("conflict", "The thread no longer lives in this chat")
  const forwarded = yield* sql<{ readonly message_json: string }>`SELECT message_json
    FROM session_messages
    WHERE session_id = ${payload.forwarded.sessionId}
      AND message_id = ${payload.forwarded.messageId}`
  const stored: unknown =
    forwarded[0] === undefined ? undefined : JSON.parse(forwarded[0].message_json)
  const content =
    typeof stored === "object" && stored !== null && "content" in stored
      ? stored.content
      : undefined
  return {
    ...owner,
    source_name: owner.source_name ?? "Source chat",
    images: userContent(content).images
  }
})

export const enqueueRunDelivery = Effect.fn(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly eventId: string
  readonly subject: string
  readonly body: string
  readonly payload: RunDeliveryPayload
  readonly now: string
}) {
  const deliveryId = sha256Hex(options.eventId)
  yield* options.sql`INSERT INTO automation_deliveries (
    delivery_id, task_id, delivered_at, subject, body, payload, status, created_at, destinations
  ) VALUES (${deliveryId}, NULL, NULL, ${options.subject}, ${options.body}, ${JSON.stringify(options.payload)},
    'pending', ${options.now}, '[]') ON CONFLICT(delivery_id) DO NOTHING`.pipe(
    Effect.mapError((cause) => workError("storage", "Could not queue the Run delivery", cause))
  )
  return deliveryId
})

export const readDeliveryForAdmission = Effect.fn(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly deliveryId: string
  readonly sessionId: string
  readonly admittedWith: ReadonlyArray<string>
  readonly content: unknown
}) {
  const content =
    typeof options.content === "string" ? options.content : userContent(options.content).text
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
  if (payload.sessionId !== options.sessionId || row.body !== content) {
    return yield* workError("invalid", "Arrival destination or content changed")
  }
  if (payload.kind === "thread") yield* threadDeliveryOwner(options.sql, payload)
  if (payload.kind !== "update" && payload.timeout === true) {
    const stopped = yield* options.sql`SELECT 1 FROM chat_runs WHERE run_id = ${payload.runIds[0]}
      AND ${stoppedRunSql()}`
    if (stopped.length > 0) return yield* workError("conflict", "The asking run was stopped")
  }
  if (payload.kind === "answer" && payload.context.task) {
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
) =>
  delivery?.kind === "update" && delivery.update.weight === "owed"
    ? liftChat(sql, sessionEvents, { sessionId: delivery.sessionId, at })
    : Effect.void

export const makeWorkDeliverySql = ({
  writer,
  sessionEvents,
  diagnostics
}: Pick<PersistenceDeps, "writer" | "sessionEvents" | "diagnostics">) => {
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
  const pendingDeliveries: WorkStore["Service"]["pendingDeliveries"] = Effect.fn(function* () {
    const now = DateTime.formatIso(yield* DateTime.now)
    const settlement = yield* writer
      .transact(
        Effect.gen(function* () {
          const missingResults = yield* sql<{
            readonly attempt_count: number
            readonly delivery_id: string
            readonly source_run_id: string
          }>`SELECT delivery_id, attempt_count, ${deliverySourceSql(sql, sql`payload`)} AS source_run_id
      FROM automation_deliveries AS delivery
      WHERE status = 'pending' AND json_extract(payload, '$.kind') = 'result'
        AND NOT EXISTS (SELECT 1 FROM sessions
          WHERE session_id = json_extract(delivery.payload, '$.sessionId'))`
          const missingEvents = yield* Effect.forEach(
            missingResults,
            Effect.fn(function* (row) {
              const incidentId = `delivery:${row.delivery_id}`
              const inserted = yield* sql`INSERT INTO delivery_incidents (
        incident_id, delivery_id, code, summary, source_run_id, created_at
      ) VALUES (
        ${incidentId}, ${row.delivery_id}, 'delivery.unroutable', ${unroutableSummary},
        ${row.source_run_id}, ${now}
      ) ON CONFLICT DO NOTHING RETURNING incident_id`
              return inserted.length === 0
                ? null
                : ({
                    code: "delivery.unroutable",
                    severity: "error",
                    cause: "Delivery destination no longer exists",
                    deliveryId: row.delivery_id,
                    sourceRunId: row.source_run_id,
                    attempt: row.attempt_count,
                    incidentId
                  } satisfies OperationalEventInput)
            })
          )
          const deleted = yield* sql<{
            readonly question_id: string | null
          }>`UPDATE automation_deliveries AS delivery SET status = 'discarded',
      payload = json_set(payload, '$.withdrawal', json_object('at', ${now}, 'reason', 'destination_deleted'))
      WHERE status = 'pending' AND json_extract(payload, '$.sessionId') IS NOT NULL
        AND ${turnDeliveryKindSql(sql, sql`payload`)}
        AND NOT EXISTS (SELECT 1 FROM sessions
          WHERE session_id = json_extract(delivery.payload, '$.sessionId'))
      RETURNING json_extract(payload, '$.questionId') AS question_id`
          yield* sql`UPDATE automation_deliveries AS delivery SET status = 'discarded',
      payload = json_set(payload, '$.withdrawal', json_object('at', ${now}, 'reason', 'destination_archived'))
      WHERE status = 'pending' AND json_extract(payload, '$.kind') = 'update'
        AND EXISTS (SELECT 1 FROM sessions
          WHERE session_id = json_extract(delivery.payload, '$.sessionId') AND archived_at IS NOT NULL)`
          const revoked = yield* sql<{
            readonly question_id: string | null
          }>`UPDATE automation_deliveries AS delivery SET status = 'discarded',
      payload = json_set(payload, '$.withdrawal', json_object('at', ${now}, 'reason', 'execution_allowance_unavailable'))
      WHERE status = 'pending' AND json_extract(payload, '$.kind') = 'answer'
        AND EXISTS (SELECT 1 FROM json_each(delivery.payload, '$.runIds') AS member
          JOIN chat_runs AS run ON run.run_id = member.value
          WHERE ${executionBudgetExpired(sql, sql`run.metadata_json`)}
            OR (json_extract(delivery.payload, '$.timeout') = 1 AND
              ${stoppedRunSql("run")}))
      RETURNING json_extract(payload, '$.questionId') AS question_id`
          const terminal = yield* sql<{
            readonly attempt_count: number
            readonly delivery_id: string
            readonly session_id: string
            readonly source_run_id: string
          }>`SELECT delivery_id, attempt_count, json_extract(payload, '$.sessionId') AS session_id,
        ${deliverySourceSql(sql, sql`payload`)} AS source_run_id
      FROM automation_deliveries AS delivery
      WHERE delivery.status = 'pending'
        AND json_extract(delivery.payload, '$.kind') = 'result'
        AND EXISTS (SELECT 1 FROM sessions AS destination
          WHERE destination.session_id = json_extract(delivery.payload, '$.sessionId')
            AND destination.session_type = 'agent')
        AND NOT EXISTS (SELECT 1 FROM chat_runs AS destination_run
          WHERE destination_run.session_id = json_extract(delivery.payload, '$.sessionId')
            AND destination_run.status IN ${activeRunStatusList})
        AND ${childAgentResult(sql, sql`delivery.payload`)}
        AND EXISTS (SELECT 1 FROM chat_runs AS source
          WHERE source.run_id = json_extract(delivery.payload, '$.runIds[0]')
            AND source.status IN ${terminalRunStatusList})`
          const terminalEvents = yield* Effect.forEach(
            terminal,
            Effect.fn(function* (row) {
              const routes = yield* sql<{
                readonly session_id: string
              }>`WITH RECURSIVE ${sessionAncestors(sql, {
                name: "ancestors",
                from: sql`SELECT parent.session_id FROM sessions AS destination
                  JOIN sessions AS parent ON parent.session_id = destination.parent_session_id
                  WHERE destination.session_id = ${row.session_id}`,
                depth: { max: 63 }
              })}
        SELECT session.session_id FROM ancestors
        JOIN sessions AS session ON session.session_id = ancestors.session_id
        WHERE ${userChatSql("session")} AND session.archived_at IS NULL
        ORDER BY ancestors.depth LIMIT 1`
              const route = routes[0]
              if (route !== undefined) {
                const updated = yield* sql`UPDATE automation_deliveries SET
          payload = json_set(payload,
            '$.sessionId', ${route.session_id},
            '$.routing', json_object(
              'at', ${now},
              'fromSessionId', ${row.session_id},
              'toSessionId', ${route.session_id}
            )),
          next_attempt_at = NULL,
          last_error = NULL
          WHERE delivery_id = ${row.delivery_id} AND status = 'pending'
          RETURNING delivery_id`
                return updated.length === 0
                  ? null
                  : ({
                      code: "delivery.rerouted",
                      severity: "info",
                      cause: null,
                      deliveryId: row.delivery_id,
                      sourceRunId: row.source_run_id,
                      fromSessionId: row.session_id,
                      toSessionId: route.session_id,
                      attempt: row.attempt_count
                    } satisfies OperationalEventInput)
              }
              const incidentId = `delivery:${row.delivery_id}`
              const inserted = yield* sql`INSERT INTO delivery_incidents (
        incident_id, delivery_id, code, summary, source_run_id, created_at
      ) VALUES (
        ${incidentId}, ${row.delivery_id}, 'delivery.unroutable', ${unroutableSummary},
        ${row.source_run_id}, ${now}
      ) ON CONFLICT DO NOTHING RETURNING incident_id`
              yield* sql`UPDATE automation_deliveries SET status = 'discarded',
        payload = json_set(payload, '$.settlement', json_object(
          'at', ${now}, 'reason', 'destination_terminal', 'mode', 'discarded'))
        WHERE delivery_id = ${row.delivery_id} AND status = 'pending'`
              return inserted.length === 0
                ? null
                : ({
                    code: "delivery.unroutable",
                    severity: "error",
                    cause: "Terminal destination has no visible parent conversation",
                    deliveryId: row.delivery_id,
                    sourceRunId: row.source_run_id,
                    attempt: row.attempt_count,
                    incidentId
                  } satisfies OperationalEventInput)
            })
          )
          const blocked = yield* sql<{
            readonly attempt_count: number
            readonly delivery_id: string
            readonly destination_session_id: string
            readonly source_run_id: string
          }>`SELECT delivery_id, attempt_count,
        json_extract(payload, '$.sessionId') AS destination_session_id,
        ${deliverySourceSql(sql, sql`payload`)} AS source_run_id
      FROM automation_deliveries AS delivery
      WHERE status = 'pending' AND payload IS NOT NULL
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
        AND ${turnDeliveryKindSql(sql, sql`payload`)}
        AND EXISTS (SELECT 1 FROM sessions AS session
          WHERE session.session_id = json_extract(delivery.payload, '$.sessionId')
            AND session.archived_at IS NULL)
        AND (
          EXISTS (SELECT 1 FROM chat_runs AS run
            WHERE run.session_id = json_extract(delivery.payload, '$.sessionId')
              AND run.status IN ${activeRunStatusList}
              AND (run.status = 'pending' OR NOT (${steersRun(sql, sql`delivery.payload`, sql`run.run_id`)})))
          OR EXISTS (SELECT 1 FROM tool_approvals AS approval
            WHERE approval.session_id = json_extract(delivery.payload, '$.sessionId')
              AND approval.status = 'pending')
        )`
          const blockedEvents = yield* Effect.forEach(
            blocked,
            Effect.fn(function* (row) {
              const attempt = row.attempt_count + 1
              const nextAttemptAt = nextOutboxAttemptAt(Date.parse(now), attempt)
              const cause = "Arrival waits for the current Chat turn or pending approval"
              const updated = yield* sql`UPDATE automation_deliveries SET
        attempt_count = ${attempt}, next_attempt_at = ${nextAttemptAt}, last_error = ${cause}
        WHERE delivery_id = ${row.delivery_id} AND status = 'pending'
          AND attempt_count = ${row.attempt_count}
        RETURNING delivery_id`
              return updated.length === 0
                ? null
                : ({
                    code: "delivery.retry_scheduled",
                    severity: "warning",
                    cause,
                    deliveryId: row.delivery_id,
                    sourceRunId: row.source_run_id,
                    destinationSessionId: row.destination_session_id,
                    attempt,
                    nextAttemptAt
                  } satisfies OperationalEventInput)
            })
          )
          yield* Effect.forEach(
            [...deleted, ...revoked],
            (row) =>
              row.question_id === null
                ? Effect.void
                : appendQuestionChange({ sql, sessionEvents, questionId: row.question_id }),
            { discard: true }
          )
          const operationalEvents: Array<OperationalEventInput> = []
          for (const event of [...missingEvents, ...terminalEvents, ...blockedEvents]) {
            if (event !== null) operationalEvents.push(event)
          }
          return { operationalEvents }
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          workError("storage", "Could not settle answer continuations", cause)
        )
      )
    yield* Effect.forEach(settlement.operationalEvents, diagnostics.operational, { discard: true })
    const rows = yield* sql<{
      readonly attempt_count: number
      readonly delivery_id: string
      readonly subject: string
      readonly body: string
      readonly payload: string
    }>`
      SELECT attempt_count, delivery_id, subject, body, payload
      FROM automation_deliveries AS delivery
      WHERE status = 'pending' AND payload IS NOT NULL
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
        AND ${turnDeliveryKindSql(sql, sql`payload`)}
        AND EXISTS (SELECT 1 FROM sessions AS session
          WHERE session.session_id = json_extract(delivery.payload, '$.sessionId') AND session.archived_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM chat_runs AS run
          WHERE run.session_id = json_extract(delivery.payload, '$.sessionId')
            AND run.status IN ${activeRunStatusList}
            AND (run.status = 'pending' OR NOT (${steersRun(sql, sql`delivery.payload`, sql`run.run_id`)})))
        AND NOT EXISTS (SELECT 1 FROM tool_approvals AS approval
          WHERE approval.session_id = json_extract(delivery.payload, '$.sessionId') AND approval.status = 'pending')
        AND NOT (COALESCE(json_extract(delivery.payload, '$.progress'), 0) = 1
          AND EXISTS (SELECT 1 FROM chat_runs AS child
            WHERE child.run_id = json_extract(delivery.payload, '$.runIds[0]')
              AND child.status IN ${activeRunStatusList})
          AND NOT EXISTS (SELECT 1 FROM chat_runs AS parent
            WHERE parent.session_id = json_extract(delivery.payload, '$.sessionId')
              AND parent.status IN ${activeRunStatusList}))
        AND NOT (${awaitsSiblingAgents(sql, sql`delivery.payload`, sql`delivery.created_at`, now)})
        AND (json_extract(delivery.payload, '$.kind') <> 'thread'
          OR EXISTS (SELECT 1 FROM focus_choices AS choice
            WHERE choice.question_id = json_extract(delivery.payload, '$.questionId')
              AND choice.decision = 'open_target'
              AND choice.result_session_id = json_extract(delivery.payload, '$.sessionId')
              AND choice.revision = json_extract(delivery.payload, '$.revision')))
        AND (json_extract(delivery.payload, '$.kind') <> 'answer'
          OR json_extract(delivery.payload, '$.context.task') IS NULL
          OR EXISTS (SELECT 1 FROM space_tasks AS task LEFT JOIN spaces AS space ON space.space_id = task.space_id
            WHERE task.item_id = json_extract(delivery.payload, '$.context.task.item_id')
              AND task.generation = json_extract(delivery.payload, '$.context.task.generation')
              AND ${taskOpenSql("task")}
              AND task.owner = 'worker'
              AND (task.space_id IS NULL OR space.archived_at IS NULL)))
      ORDER BY created_at, delivery_id LIMIT 32
    `.pipe(
      Effect.mapError((cause) => workError("storage", "Could not read pending arrivals", cause))
    )
    return yield* Effect.forEach(rows, (row) =>
      decodeJson(RunDeliveryPayloadSchema, row.payload).pipe(
        Effect.flatMap((payload): Effect.Effect<RunDelivery, WorkStoreError | SqlError> => {
          if (payload.kind === "thread")
            return threadDeliveryOwner(sql, payload).pipe(
              Effect.map((owner) => ({
                images: owner.images,
                forwardedFrom: {
                  session_id: payload.forwarded.sessionId,
                  session_ref: owner.source_ref,
                  message_id: payload.forwarded.messageId
                },
                deliveryId: row.delivery_id,
                attempt: row.attempt_count,
                subject: row.subject,
                body: row.body,
                payload,
                interaction: {
                  kind: "message" as const,
                  from: {
                    type: "agent" as const,
                    id: owner.source_ref,
                    display_name: owner.source_name
                  },
                  to: { type: "agent" as const, id: owner.target_ref },
                  content: row.body
                }
              }))
            )
          if (payload.kind === "answer" || payload.kind === "connection")
            return Effect.succeed({
              deliveryId: row.delivery_id,
              attempt: row.attempt_count,
              subject: row.subject,
              body: row.body,
              payload
            })
          if (payload.kind === "update")
            return Effect.succeed({
              deliveryId: row.delivery_id,
              attempt: row.attempt_count,
              subject: row.subject,
              body: row.body,
              payload,
              interaction: updateInteraction(payload, row.body)
            })
          return sql<{
            readonly source_ref: string
            readonly source_name: string
            readonly destination_ref: string
            readonly source_status: ChatRunRecord["status"]
            readonly source_stop_reason: ChatRunRecord["stopReason"]
            readonly ending_status: EndingRecord["status"] | null
            readonly ending_detail: EndingRecord["detail"]
            readonly ending_text: string | null
            readonly no_change_reason: string | null
          }>`SELECT source.public_ref AS source_ref, source.name AS source_name,
          destination.public_ref AS destination_ref,
          source_run.status AS source_status, source_run.stop_reason AS source_stop_reason,
          ending.status AS ending_status, ending.detail AS ending_detail, ending.text AS ending_text,
          json_extract(source_run.metadata_json, '$.no_change_reason') AS no_change_reason
          FROM chat_runs AS source_run
          LEFT JOIN run_endings AS ending ON ending.run_id = source_run.run_id AND ending.decided = 1
          JOIN sessions AS source ON source.session_id = source_run.session_id
            AND source.session_type = 'agent'
          JOIN sessions AS destination ON destination.session_id = ${payload.sessionId}
          WHERE source_run.run_id = ${payload.runIds[0]}`.pipe(
            Effect.flatMap((identities) => {
              const identity = identities[0]
              if (identity === undefined) {
                return Effect.fail(workError("storage", "Worker arrival has no source agent"))
              }
              const report = parentCompletion({
                runId: payload.runIds[0],
                sessionRef: identity.source_ref,
                status: identity.source_status,
                stopReason: identity.source_stop_reason,
                ending:
                  identity.ending_status === null
                    ? undefined
                    : {
                        status: identity.ending_status,
                        detail: identity.ending_detail,
                        text: identity.ending_text ?? ""
                      },
                noChangeReason: identity.no_change_reason ?? undefined
              })
              return Effect.succeed({
                deliveryId: row.delivery_id,
                attempt: row.attempt_count,
                subject: row.subject,
                body: row.body,
                payload,
                interaction:
                  payload.progress === true
                    ? {
                        kind: "message" as const,
                        from: {
                          type: "agent" as const,
                          id: identity.source_ref,
                          display_name: identity.source_name
                        },
                        to: { type: "agent" as const, id: identity.destination_ref },
                        content: `Update from the worker:\n${row.body}`,
                        causedBy: { type: "run" as const, id: payload.runIds[0] }
                      }
                    : {
                        kind: "completion" as const,
                        from: {
                          type: "agent" as const,
                          id: identity.source_ref,
                          display_name: identity.source_name
                        },
                        to: { type: "agent" as const, id: identity.destination_ref },
                        content: row.body,
                        outcome: report.outcome,
                        causedBy: { type: "run" as const, id: payload.runIds[0] }
                      }
              })
            })
          )
        }),
        Effect.mapError((cause) => workError("storage", "Stored arrival is corrupt", cause))
      )
    )
  })
  const acknowledgeDelivery: WorkStore["Service"]["acknowledgeDelivery"] = Effect.fn(
    function* (deliveryId, runId) {
      const now = DateTime.formatIso(yield* DateTime.now)
      yield* writer
        .run(
          sql`UPDATE automation_deliveries SET status = 'delivered', delivered_at = ${now},
      destinations = ${JSON.stringify([`chat:${runId}`])}
      WHERE delivery_id = ${deliveryId} AND status = 'pending'`
        )
        .pipe(
          Effect.mapError((cause) =>
            workError("storage", "Could not acknowledge the arrival", cause)
          ),
          Effect.asVoid
        )
    }
  )
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
        AND (${runAuthorityState(sql, sql`run.metadata_json`, sql`run.run_id`)} = 'revoked'
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
    acknowledgeDelivery,
    discardStoppedResults,
    deferDelivery,
    revokedRuns,
    reportNoChange
  }
}
