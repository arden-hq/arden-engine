import type { RunContext, RunOrigin } from "../runs/stored-context.js"
import type { AgentMode, CommunicationDoor } from "@arden-hq/protocol/chat"
import { RUN_ORIGIN } from "@arden-hq/protocol/runs"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { taskDoor, type ArrivalEvent } from "./ending-arrival.js"
import { tellChat, updateWeight } from "./owner-update.js"
import { runDoor, type SourceRunRow } from "./continuity-route.js"
import { chatRow, type Place, type RunAddress } from "./run-destination.js"
import {
  ENDING_DETAIL,
  ENDING_PURPOSE,
  ENDING_STATUS,
  PLACE_KIND,
  type EndingRecord,
  type EndingStatus
} from "../runs/ending.js"
import { parentCompletion } from "../runs/parent-completion.js"
import type { ChatRunRecord } from "../runs/model.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { enqueueRunDelivery } from "./work-delivery-routing.js"

export const workerNames: Record<AgentMode, string> = {
  code: "Code worker",
  research: "Research worker",
  work: "Worker"
}

export const deliver = Effect.fn("RunEnding.deliver")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly record: EndingRecord; readonly address: RunAddress; readonly now: string }
) {
  const { record, address } = input
  const { place, source } = address
  const { context, owner } = address.reply
  if (record.purpose === ENDING_PURPOSE.taskExecution && owner?.kind === RUN_ORIGIN.task)
    yield* tellCriteriaMet(sql, {
      runId: record.runId,
      itemId: owner.item_id,
      place,
      source,
      occurredAt: record.occurredAt
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("A met criterion was not told", cause)),
      Effect.catchDefect((defect) => Effect.logWarning("A met criterion was not told", defect))
    )
  if (record.placeKind === PLACE_KIND.parent) {
    if (context === undefined || record.place === null || address.agent === undefined)
      return yield* Effect.fail(new Error("The worker outcome has no parent to return to"))
    const state = (yield* sql<{
      readonly status: ChatRunRecord["status"]
      readonly stop_reason: ChatRunRecord["stopReason"]
      readonly no_change_reason: string | null
    }>`SELECT status, stop_reason, json_extract(metadata_json, '$.no_change_reason') AS no_change_reason
      FROM chat_runs WHERE run_id = ${record.runId}`)[0]
    if (state === undefined) return yield* Effect.fail(new Error("The worker run is missing"))
    const report = parentCompletion({
      runId: record.runId,
      sessionRef: source.source_ref,
      status: state.status,
      stopReason: state.stop_reason,
      ending: record,
      noChangeReason: state.no_change_reason ?? undefined
    })
    yield* enqueueRunDelivery({
      sql,
      eventId: `ending:run:${record.runId}`,
      subject: `${workerNames[address.agent.mode]} ${report.label}`,
      body: report.text,
      payload: {
        kind: "result",
        sessionId: record.place,
        context,
        runIds: [record.runId],
        questionId: null
      },
      now: input.now
    })
    return
  }
  const weight = updateWeight({ kind: "ending", record, shown: record.shown })
  if (weight === undefined) return
  if (place.kind !== PLACE_KIND.chat || context === undefined || owner === undefined)
    return yield* Effect.fail(new Error("The ending has no chat to be told in"))
  if (record.purpose === ENDING_PURPOSE.taskExecution && (yield* oldPollTold(sql, record.runId)))
    return
  yield* tellChat({
    sql,
    weight,
    occurrenceKey: `ending:run:${record.runId}`,
    source: { kind: "ending", runId: record.runId },
    sourceRunId: record.runId,
    sourceSessionRef: source.source_ref,
    destination: place.row,
    line: record.text,
    door: yield* doorOf(sql, owner, source, context),
    event:
      record.status === ENDING_STATUS.finished && record.detail === ENDING_DETAIL.step
        ? "told"
        : arrivalEvent(record.status),
    occurredAt: record.occurredAt
  })
})

const tellCriteriaMet = Effect.fn("RunEnding.criteriaMet")(function* (
  sql: SqlClient.SqlClient,
  wake: {
    readonly runId: string
    readonly itemId: string
    readonly place: Place
    readonly source: SourceRunRow
    readonly occurredAt: string
  }
) {
  const closed = yield* sql`SELECT 1 FROM space_task_events
    WHERE item_id = ${wake.itemId} AND run_ref = ${wake.runId}
      AND event_type IN ('done', 'cancelled') LIMIT 1`
  if (closed.length > 0) return
  const task = (yield* sql<{ readonly text: string }>`
    SELECT text FROM space_tasks WHERE item_id = ${wake.itemId}`)[0]
  if (task === undefined) return
  const met = yield* sql<{
    readonly line_id: number
    readonly text: string
    readonly attachment_id: number | null
    readonly attachment_name: string | null
  }>`SELECT line.line_id, line.text,
      json_extract(line.evidence_json, '$[#-1].evidence.attachment_id') AS attachment_id,
      json_extract(line.evidence_json, '$[#-1].evidence.name') AS attachment_name
    FROM task_contract_lines AS line
    JOIN chat_runs AS run ON run.run_id = ${wake.runId}
    WHERE line.item_id = ${wake.itemId} AND line.kind = 'criterion' AND line.retired_at IS NULL
      AND line.line_id IN (SELECT json_extract(call.arguments_json, '$.line_id') FROM tool_calls AS call
        WHERE call.run_id = ${wake.runId} AND call.tool_name = 'task_criterion_met'
          AND call.status = 'completed' AND COALESCE(json_extract(call.result_json, '$.is_error'), 0) = 0)
      AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(line.evidence_json, '[]')) AS entry
        WHERE julianday(json_extract(entry.value, '$.recorded_at')) < julianday(run.started_at))
    ORDER BY line.line_id`
  if (met.length === 0) return
  let destination = wake.place.row
  if (wake.place.kind === PLACE_KIND.own) destination = yield* chatRow(sql, wake.place.sessionId)
  if (destination === undefined) {
    yield* Effect.logInfo("A met criterion has no chat to be told in", wake.itemId)
    return
  }
  const weight = updateWeight({ kind: "met", shown: wake.place.kind === PLACE_KIND.chat })
  if (weight === undefined) return
  for (const line of met)
    yield* tellChat({
      sql,
      weight,
      occurrenceKey: `criterion-met:${wake.runId}:${line.line_id}`,
      source: { kind: "met", runId: wake.runId, lineId: line.line_id },
      sourceRunId: wake.runId,
      sourceSessionRef: wake.source.source_ref,
      destination,
      line: line.text,
      door:
        line.attachment_id !== null && line.attachment_name !== null
          ? {
              kind: "artifact",
              label: line.attachment_name,
              item_id: wake.itemId,
              attachment_id: line.attachment_id,
              href: `arden:task/${encodeURIComponent(wake.itemId)}`
            }
          : taskDoor(wake.itemId, task.text),
      event: "met",
      occurredAt: wake.occurredAt
    })
})

const oldPollTold = Effect.fn("RunEnding.oldPollTold")(function* (
  sql: SqlClient.SqlClient,
  runId: string
) {
  const events = yield* sql<{ readonly event_id: number }>`SELECT event_id FROM space_task_events
    WHERE run_ref = ${runId} AND event_type IN ('done', 'reported')
      AND NOT EXISTS (SELECT 1 FROM entity_events WHERE key = 'task-done:' || event_id)`
  if (events.length === 0) return false
  const ids = events.map((event) => sha256Hex(`task-event:${event.event_id}`))
  return (
    (yield* sql`SELECT 1 FROM automation_deliveries WHERE delivery_id IN ${sql.in(ids)}`).length > 0
  )
})

const arrivalEvent = (status: EndingStatus): ArrivalEvent => {
  switch (status) {
    case ENDING_STATUS.blocked:
      return "blocked"
    case ENDING_STATUS.failed:
      return "failed"
    case ENDING_STATUS.finished:
    case ENDING_STATUS.cancelled:
    case ENDING_STATUS.silent:
    case ENDING_STATUS.waiting:
      return "finished"
  }
}

export const doorOf = Effect.fn("RunEnding.door")(function* (
  sql: SqlClient.SqlClient,
  origin: RunOrigin,
  source: SourceRunRow,
  context: RunContext
): Effect.fn.Return<CommunicationDoor, SqlError> {
  if (origin.kind === RUN_ORIGIN.task) {
    const task = (yield* sql<{ readonly text: string }>`SELECT text FROM space_tasks
      WHERE item_id = ${origin.item_id}`)[0]
    return taskDoor(origin.item_id, task?.text ?? "Task")
  }
  return yield* runDoor(sql, "Open run", source, context)
})
