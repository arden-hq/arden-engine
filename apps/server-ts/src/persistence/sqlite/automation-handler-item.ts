import { Clock, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { JobLeaseRef } from "@arden-hq/jobs"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import { AutomationStoreError } from "../automations/store.js"
import { AutomationHandlerItems } from "../automations/handler-items.js"
import {
  HandlerItemInputSchema,
  HandlerItemRefSchema,
  HandlerItemSchema,
  MAX_HANDLER_ITEM_ATTEMPTS,
  handlerItemClientId,
  type HandlerItem,
  type HandlerItemInput,
  type HandlerItemRef
} from "../automations/handler-item.js"
import type { AutomationRules } from "../automations/model.js"
import { QueueContextSchema, type QueueContext } from "./automation-queue-context.js"
import { parseLease } from "./automation-lease.js"
import { nextId, type Writer } from "./deps.js"
import { decodeJson, encodeJson } from "./json.js"
import { iso } from "../../runtime/clock.js"

const failure = (message: string, cause?: unknown) =>
  new AutomationStoreError({
    operation: "handler_item",
    reason: "conflict",
    message,
    ...(cause === undefined ? {} : { cause })
  })

const load = Effect.fn("HandlerItem.load")(function* (
  sql: SqlClient.SqlClient,
  lease: JobLeaseRef
) {
  const parsed = parseLease(lease)
  const rows = yield* sql<{ readonly context: string; readonly handler: string | null }>`
    SELECT queue.context, task.handler FROM automation_event_queue AS queue
    JOIN scheduled_tasks AS task ON task.task_id = queue.task_id
    JOIN automation_runs AS run ON run.id = ${parsed.runId} AND run.task_id = queue.task_id
    WHERE queue.id = ${parsed.queueId} AND queue.claimed_at IS NOT NULL
      AND run.claim_count = ${parsed.claimAttempt}
      AND queue.lease_expires_at > ${iso(yield* Clock.currentTimeMillis)} AND run.status = 'running'
      AND json_extract(queue.context, '$.automation_run_id') = run.id`
  const row = rows[0]
  if (!row) return yield* failure("The handler lease is no longer current")
  return {
    ...parsed,
    handler: row.handler,
    context: yield* decodeJson(QueueContextSchema, row.context)
  }
})

const save = Effect.fn("HandlerItem.save")(function* (
  sql: SqlClient.SqlClient,
  current: { readonly queueId: number; readonly context: QueueContext },
  item: HandlerItem
) {
  const encoded = yield* encodeJson(QueueContextSchema, { ...current.context, handler_item: item })
  yield* sql`UPDATE automation_event_queue SET context = ${encoded} WHERE id = ${current.queueId}`
  return item
})

export const makeHandlerItems = ({
  writer,
  rules
}: {
  readonly writer: Writer
  readonly rules: Pick<AutomationRules["Service"], "itemOwner">
}): AutomationHandlerItems["Service"] => {
  const sql = writer.sql
  const prepareHandlerItem: AutomationHandlerItems["Service"]["prepareHandlerItem"] = Effect.fn(
    "HandlerItem.prepare"
  )(
    function* (lease, input) {
      const valid = yield* Schema.decodeUnknownEffect(HandlerItemInputSchema)(input)
      return yield* writer.transact(
        Effect.gen(function* () {
          const current = yield* load(sql, lease)
          if (current.handler !== rules.itemOwner(valid.data.kind))
            return yield* failure("The handler does not own this item kind")
          if (current.context.handler_item?.phase === "pending") return current.context.handler_item
          return yield* save(sql, current, {
            id: yield* nextId,
            attempt: 1,
            phase: "pending",
            runId: null,
            reviewed: current.context.handler_item?.reviewed ?? 0,
            skipped: current.context.handler_item?.skipped ?? 0,
            previousRunId:
              current.context.handler_item?.runId ??
              current.context.handler_item?.previousRunId ??
              null,
            input: valid
          })
        })
      )
    },
    Effect.mapError((cause) =>
      cause instanceof AutomationStoreError
        ? cause
        : failure("Could not prepare handler input", cause)
    )
  )

  const transition = (kind: "settle" | "retry") =>
    Effect.fn("HandlerItem.transition")(
      function* (lease: JobLeaseRef, ref: HandlerItemRef) {
        const valid = yield* Schema.decodeUnknownEffect(HandlerItemRefSchema)(ref)
        return yield* writer.transact(
          Effect.gen(function* () {
            const current = yield* load(sql, lease)
            const item = current.context.handler_item
            if (!item || item.id !== valid.id) return yield* failure("The handler item changed")
            if (kind === "retry" && item.attempt === valid.attempt + 1) return item
            if (item.attempt !== valid.attempt || item.runId === null)
              return yield* failure("The handler execution changed")
            if (kind === "settle" && item.phase === "settled") return item
            if (item.phase !== "pending") return yield* failure("The handler item already settled")
            const observed = yield* sql<{
              readonly status: string
              readonly blocked_kind: string | null
              readonly detail: string | null
            }>`
        SELECT run.status, json_extract(sidecar.evidence_json, '$.automation_outcome.kind') AS blocked_kind,
          COALESCE(json_extract(sidecar.evidence_json, '$.automation_outcome.reason'), run.error_message, run.stop_reason) AS detail
        FROM chat_runs AS run LEFT JOIN run_sidecars AS sidecar ON sidecar.run_id = run.run_id
        WHERE run.run_id = ${item.runId} AND run.session_id = ${item.input.sessionId}`
            const run = observed[0]
            if (!run || isActiveRunStatus(run.status))
              return yield* failure("The handler Run has not finished")
            if (run.status === "cancelled")
              return yield* failure("Cancelled handler work cannot retry or consume evidence")
            if (kind === "settle")
              return yield* save(sql, current, {
                ...item,
                phase: "settled",
                runId: item.runId,
                reviewed:
                  item.reviewed + (run.status === "completed" && run.blocked_kind === null ? 1 : 0),
                skipped:
                  item.skipped + (run.status === "completed" && run.blocked_kind === null ? 0 : 1),
                failure:
                  run.status === "completed" && run.blocked_kind === null
                    ? null
                    : (run.detail ?? `Handler Run ${run.status}`)
              })
            if (run.status === "completed" && run.blocked_kind !== "transient")
              return yield* failure("Completed handler work cannot be retried")
            if (item.attempt >= MAX_HANDLER_ITEM_ATTEMPTS)
              return yield* failure("Handler execution attempts are exhausted")
            return yield* save(sql, current, {
              ...item,
              attempt: item.attempt + 1,
              phase: "pending",
              previousRunId: item.runId,
              runId: null
            })
          })
        )
      },
      Effect.mapError((cause) =>
        cause instanceof AutomationStoreError
          ? cause
          : failure("Could not checkpoint handler work", cause)
      )
    )

  return AutomationHandlerItems.of({
    prepareHandlerItem,
    settleHandlerItem: transition("settle"),
    retryHandlerItem: transition("retry")
  })
}

export const bindHandlerItem = Effect.fn("HandlerItem.bind")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly lease: JobLeaseRef
    readonly item?: HandlerItemRef
    readonly runId: string
    readonly sessionId: string
    readonly clientId: string
    readonly name: string
    readonly prompt: string
    readonly itemPrompt: (input: HandlerItemInput) => string
  }
) {
  const current = yield* load(sql, options.lease)
  const item = current.context.handler_item
  if (item === undefined && options.item === undefined) return
  if (
    !item ||
    options.item === undefined ||
    item.phase !== "pending" ||
    item.runId !== null ||
    item.id !== options.item.id ||
    item.attempt !== options.item.attempt ||
    item.input.sessionId !== options.sessionId ||
    item.input.name !== options.name ||
    handlerItemClientId(item) !== options.clientId ||
    options.itemPrompt(item.input) !== options.prompt
  ) {
    return yield* failure("Chat admission does not match the frozen handler item")
  }
  const bound = yield* Schema.decodeUnknownEffect(HandlerItemSchema)({
    ...item,
    runId: options.runId
  })
  yield* save(sql, current, bound)
  if (bound.input.data.kind === "memory") {
    const identity = JSON.stringify(bound.input.data.batch.identity)
    yield* sql`UPDATE chat_runs
      SET metadata_json = json_set(metadata_json, '$.memory_capture_batch', json(${identity}))
      WHERE run_id = ${options.runId} AND session_id = ${options.sessionId}`
  }
})
