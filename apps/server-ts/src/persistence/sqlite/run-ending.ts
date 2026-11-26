import type { RunOrigin } from "../runs/stored-context.js"
import { parseJsonTextOrUndefined } from "@arden-hq/protocol/common"
import { automationRepeats } from "@arden-hq/protocol/automations"
import { AUTOMATION_TRIGGER_SOURCE } from "@arden-hq/protocol/effect/automations"
import { RUN_ORIGIN } from "@arden-hq/protocol/runs"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { serializeOperationalCause } from "../../runtime/operational-events.js"
import { isUserAutomationPurpose } from "../job-classification.js"
import { taskDoneBefore } from "./entity-events.js"
import type { EndedAutomationRun } from "./automation-run-outcome.js"
import { addressOfRun, RUN_RECORD, type Place } from "./run-destination.js"
import { changedRunOutcome, newsRunOutcome, quietRunOutcome } from "./run-outcomes.js"
import { readTaskState } from "../work/task-state.js"
import { activeRunStatusList } from "./status-sets.js"
import {
  ENDING_DETAIL,
  ENDING_PURPOSE,
  ENDING_STATUS,
  PLACE_KIND,
  EndingPurposeSchema,
  EndingStatusSchema,
  PlaceKindSchema,
  type EndingPurpose,
  type EndingRecord
} from "../runs/ending.js"
import {
  ENDING,
  saidDamaged,
  saidOf,
  shown,
  type Ending,
  type Facts,
  type Said
} from "./run-ending-said.js"
import { deliver } from "./run-ending-delivery.js"

export const recordEnding = Effect.fn("RunEnding.record")(function* (
  sql: SqlClient.SqlClient,
  ending: Ending
) {
  const runId = ending.kind === ENDING.run ? ending.runId : ending.run.chatRunId
  if (runId === null) return undefined
  const address = yield* addressOfRun(sql, runId)
  if (address === undefined) return undefined
  const { origin, owner, place, agent } = address
  const owned =
    origin?.kind === RUN_ORIGIN.automation ||
    origin?.kind === RUN_ORIGIN.task ||
    origin?.kind === RUN_ORIGIN.space
  const purpose: EndingPurpose =
    ending.kind === ENDING.occurrence &&
    !(ending.purpose === ENDING_PURPOSE.system && owner?.kind === RUN_ORIGIN.automation)
      ? ending.purpose
      : yield* purposeOf(sql, owner)
  const facts = yield* factsOf(sql, runId)
  const plain = address.damaged
    ? saidDamaged(ending)
    : saidOf({ ending, purpose, facts, agent: agent !== undefined })
  const twinExists = yield* entityTwinAt(sql, runId, place)
  const ownTask =
    purpose === ENDING_PURPOSE.taskExecution && owner?.kind === RUN_ORIGIN.task ? owner : undefined
  const recurring =
    ownTask === undefined ? false : yield* taskDoneBefore(sql, ownTask.item_id, runId)
  const cancelledTask =
    ownTask === undefined
      ? false
      : (yield* sql`SELECT 1 FROM space_task_events
          WHERE item_id = ${ownTask.item_id} AND run_ref = ${runId} AND event_type = 'cancelled'
          LIMIT 1`).length > 0
  const finished =
    plain.status === ENDING_STATUS.finished ||
    (plain.status === ENDING_STATUS.silent && plain.detail === ENDING_DETAIL.empty)
  const added =
    finished && ownTask !== undefined ? yield* wakeAdded(sql, ownTask.item_id, runId) : []
  const step = added.length > 0
  const said: Said = step
    ? {
        status: ENDING_STATUS.finished,
        detail: ENDING_DETAIL.step,
        text: plain.text.trim() || added.join("\n")
      }
    : plain
  const base = {
    runId,
    purpose,
    status: said.status,
    detail: said.detail,
    text: said.text,
    place: place.sessionId ?? null,
    placeKind: place.kind,
    occurredAt: ending.kind === ENDING.run ? (ending.occurredAt ?? ending.now) : ending.run.endedAt,
    decided: ending.kind === ENDING.occurrence || !owned
  }
  const repeats =
    purpose === ENDING_PURPOSE.userAutomation && (yield* automationRunRepeats(sql, runId))
  const record: EndingRecord = {
    ...base,
    shown: shown(base, {
      twinExists,
      recurring,
      cancelledTask,
      repeats,
      news: facts.news,
      changed: facts.changed
    })
  }
  const stored = yield* sql`INSERT INTO run_endings (run_id, purpose, status, detail, text, place,
      place_kind, occurred_at, shown, decided, delivery_error)
    VALUES (${record.runId}, ${record.purpose}, ${record.status}, ${record.detail}, ${record.text},
      ${record.place}, ${record.placeKind}, ${record.occurredAt}, ${record.shown ? 1 : 0},
      ${record.decided ? 1 : 0}, ${address.record.kind === RUN_RECORD.corrupt ? address.record.error : null})
    ON CONFLICT(run_id) DO UPDATE SET purpose = excluded.purpose, status = excluded.status,
      detail = excluded.detail, text = excluded.text, place = excluded.place,
      place_kind = excluded.place_kind, occurred_at = excluded.occurred_at,
      shown = excluded.shown, decided = excluded.decided,
      delivery_error = excluded.delivery_error
    WHERE run_endings.decided = 0
    RETURNING run_id`
  if (ending.kind === ENDING.occurrence) yield* decideOccurrenceEndings(sql, ending.run)
  if (stored.length === 0 || !record.decided) return record
  yield* deliver(sql, {
    record,
    address,
    now: ending.kind === ENDING.run ? ending.now : ending.run.endedAt
  }).pipe(
    Effect.catch((cause) => keepError(sql, runId, cause)),
    Effect.catchDefect((defect) => keepError(sql, runId, defect))
  )
  return record
})

const keepError = (sql: SqlClient.SqlClient, runId: string, cause: unknown) =>
  sql`UPDATE run_endings SET delivery_error = ${serializeOperationalCause(cause)} WHERE run_id = ${runId}`.pipe(
    Effect.asVoid
  )

export const purposeOf = Effect.fn("RunEnding.purpose")(function* (
  sql: SqlClient.SqlClient,
  origin: RunOrigin | undefined
): Effect.fn.Return<EndingPurpose, SqlError> {
  if (origin === undefined) return ENDING_PURPOSE.chat
  switch (origin.kind) {
    case RUN_ORIGIN.task:
      return ENDING_PURPOSE.taskExecution
    case RUN_ORIGIN.space:
      return ENDING_PURPOSE.spaceReview
    case RUN_ORIGIN.chat:
    case RUN_ORIGIN.unrecorded:
      return ENDING_PURPOSE.chat
    case RUN_ORIGIN.automation: {
      const rows = yield* sql<{
        readonly purpose: string
      }>`SELECT purpose FROM scheduled_tasks WHERE task_id = ${origin.automation_id}`
      return isUserAutomationPurpose(rows[0]?.purpose)
        ? ENDING_PURPOSE.userAutomation
        : ENDING_PURPOSE.system
    }
  }
})

const automationRunRepeats = Effect.fn("RunEnding.repeats")(function* (
  sql: SqlClient.SqlClient,
  runId: string
) {
  const rows = yield* sql<{
    readonly triggers: string | null
    readonly source: string | null
    readonly again: number
  }>`SELECT automation.triggers,
      json_extract(attempt.trigger_json, '$.source') AS source,
      EXISTS (SELECT 1 FROM automation_runs AS earlier
        WHERE earlier.task_id = attempt.task_id AND earlier.id < attempt.id
          AND COALESCE(json_extract(earlier.trigger_json, '$.source'), '') <> 'manual') AS again
    FROM automation_runs AS attempt
    JOIN scheduled_tasks AS automation ON automation.task_id = attempt.task_id
    WHERE attempt.chat_run_id = ${runId}
    ORDER BY attempt.id DESC LIMIT 1`
  const row = rows[0]
  if (row === undefined || row.source === AUTOMATION_TRIGGER_SOURCE.manual) return false
  return (
    row.again === 1 ||
    (row.triggers !== null && automationRepeats(parseJsonTextOrUndefined(row.triggers)))
  )
})

const entityTwinAt = Effect.fn("RunEnding.twin")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  place: Place
) {
  if (place.kind !== PLACE_KIND.chat) return false
  const rows = yield* sql`SELECT 1 FROM entity_events
    WHERE run_id = ${runId} AND place = ${place.sessionId} AND place_kind = 'chat'
    LIMIT 1`
  return rows.length > 0
})

const decideOccurrenceEndings = Effect.fn("RunEnding.decideOccurrence")(function* (
  sql: SqlClient.SqlClient,
  run: EndedAutomationRun
) {
  if (run.chatSessionId === null) return
  yield* sql`UPDATE run_endings SET decided = 1
    WHERE decided = 0 AND run_id IN (
      SELECT chat.run_id FROM chat_runs AS chat
      WHERE chat.session_id = ${run.chatSessionId}
        AND json_extract(chat.metadata_json, '$.run_context.origin') =
          json((SELECT origin FROM automation_runs WHERE id = ${run.id})))`
})

const StoredEndingSchema = Schema.Struct({
  purpose: EndingPurposeSchema,
  status: EndingStatusSchema,
  detail: Schema.NullOr(Schema.String),
  text: Schema.String,
  place: Schema.NullOr(Schema.String),
  place_kind: PlaceKindSchema,
  occurred_at: Schema.String,
  shown: Schema.Number
})

export const reconcileEndings = Effect.fn("RunEnding.reconcile")(function* (
  sql: SqlClient.SqlClient
) {
  const stale = yield* sql<{ readonly run_id: string }>`
    SELECT pending.run_id FROM run_endings AS pending
    JOIN chat_runs AS chat ON chat.run_id = pending.run_id
    WHERE pending.decided = 0 AND chat.status NOT IN ${activeRunStatusList}
      AND NOT EXISTS (SELECT 1 FROM automation_runs AS attempt
        WHERE attempt.status = 'running'
          AND json(attempt.origin) = json_extract(chat.metadata_json, '$.run_context.origin'))`
  for (const { run_id: runId } of stale) {
    const decided =
      yield* sql`UPDATE run_endings SET decided = 1 WHERE run_id = ${runId} AND decided = 0
      RETURNING purpose, status, detail, text, place, place_kind, occurred_at, shown`
    if (decided[0] === undefined) continue
    yield* Schema.decodeUnknownEffect(StoredEndingSchema)(decided[0]).pipe(
      Effect.flatMap((row) =>
        deliverStored(sql, {
          runId,
          purpose: row.purpose,
          status: row.status,
          detail: row.detail,
          text: row.text,
          place: row.place,
          placeKind: row.place_kind,
          occurredAt: row.occurred_at,
          shown: row.shown === 1,
          decided: true
        })
      ),
      Effect.catch((cause) => keepError(sql, runId, cause)),
      Effect.catchDefect((defect) => keepError(sql, runId, defect))
    )
  }
})

const deliverStored = Effect.fn("RunEnding.deliverStored")(function* (
  sql: SqlClient.SqlClient,
  record: EndingRecord
) {
  const address = yield* addressOfRun(sql, record.runId)
  if (address === undefined) return
  yield* deliver(sql, { record, address, now: record.occurredAt })
})

const factsOf = Effect.fn("RunEnding.facts")(function* (sql: SqlClient.SqlClient, runId: string) {
  const quiet =
    (yield* sql`SELECT 1 FROM chat_runs AS run WHERE run.run_id = ${runId}
    AND ${quietRunOutcome(sql, "run")}`).length > 0
  const news =
    (yield* sql`SELECT 1 FROM chat_runs AS run WHERE run.run_id = ${runId}
    AND ${newsRunOutcome(sql, "run")}`).length > 0
  const changed =
    (yield* sql`SELECT 1 FROM chat_runs AS run WHERE run.run_id = ${runId}
    AND ${changedRunOutcome(sql, "run")}`).length > 0
  const question = (yield* sql<{
    readonly question_id: string
    readonly prompt: string | null
  }>`SELECT question_id, json_extract(content, '$.prompt') AS prompt FROM run_questions
    WHERE run_id = ${runId} AND resolution IS NULL AND closed_at IS NULL LIMIT 1`)[0]
  const approval =
    question === undefined
      ? (yield* sql<{
          readonly tool_call_id: string
          readonly tool_name: string
          readonly preview: string | null
        }>`SELECT tool_call_id, tool_name, preview FROM tool_approvals
          WHERE run_id = ${runId} AND status = 'pending' LIMIT 1`)[0]
      : undefined
  const blocked = (yield* sql<{ readonly kind: string | null }>`SELECT
      json_extract(evidence_json, '$.automation_outcome.kind') AS kind
    FROM run_sidecars WHERE run_id = ${runId}`)[0]
  return {
    quiet,
    news,
    changed,
    ask: question?.question_id ?? approval?.tool_call_id ?? null,
    askLine: askLineOf(question, approval),
    blockedKind: blocked?.kind ?? null
  } satisfies Facts
})

const askLineOf = (
  question: { readonly prompt: string | null } | undefined,
  approval: { readonly tool_name: string; readonly preview: string | null } | undefined
): string => {
  if (question !== undefined) return question.prompt ?? "a question"
  if (approval === undefined) return ""
  const use = `approval to use ${approval.tool_name}`
  return approval.preview === null ? use : `${use}: ${approval.preview}`
}

const wakeAdded = Effect.fn("RunEnding.wakeAdded")(function* (
  sql: SqlClient.SqlClient,
  itemId: string,
  runId: string
) {
  const closed = yield* sql`SELECT 1 FROM space_task_events
    WHERE item_id = ${itemId} AND run_ref = ${runId}
      AND event_type IN ('done', 'cancelled') LIMIT 1`
  if (closed.length > 0) return []
  const task = (yield* sql<{ readonly state: string | null }>`
    SELECT continuation_context AS state FROM space_tasks
    WHERE item_id = ${itemId}`)[0]
  if (task === undefined) return []
  const record = yield* readTaskState(task.state)
  if (record?.run_id !== runId || record.added === undefined) return []
  return [...record.added.done, ...record.added.decided]
})
