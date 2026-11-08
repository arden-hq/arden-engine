import type { CommunicationDoor } from "@arden-hq/protocol/chat"
import { RunContextSchema } from "@arden-hq/protocol/effect/runs"
import type { RunContext, RunOrigin } from "@arden-hq/protocol/runs"
import { automationRepeats } from "@arden-hq/protocol/automations"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { serializeOperationalCause } from "../../runtime/operational-events.js"
import { isUserAutomationPurpose, type JobPurpose } from "../job-classification.js"
import { taskDoor, type ArrivalEvent } from "./ending-arrival.js"
import { tellChat, told, updateWeight, waitsOnOwner, type Readable } from "./owner-update.js"
import { taskDoneBefore } from "./entity-events.js"
import type { EndedAutomationRun } from "./automation-run-outcome.js"
import { runDoor, type SourceRunRow } from "./continuity-route.js"
import { decodeJson } from "./json.js"
import { chatRow, placeOf, type ChildAgent, type Place } from "./run-destination.js"
import { changedRunOutcome, newsRunOutcome, quietRunOutcome } from "./run-outcomes.js"
import { readTaskState } from "../work/task-state.js"
import { activeRunStatusList } from "./status-sets.js"
import { enqueueRunDelivery } from "./work-deliveries.js"
import type { EndingRecord, EndingStatus, PlaceKind, Purpose } from "../runs/ending.js"
import { parentCompletion } from "../runs/parent-completion.js"
import type { ChatRunRecord } from "../runs/model.js"
import { sha256Hex } from "@arden-hq/std/hash"

export type ToldOutcome = "finished" | "needs_you" | "blocked" | "failed"

export type RunTerminal =
  | { readonly status: "completed"; readonly result: string }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "cancelled" }

export type Ending =
  | {
      readonly kind: "run"
      readonly runId: string
      readonly terminal: RunTerminal
      readonly now: string
      readonly occurredAt?: string
    }
  | {
      readonly kind: "occurrence"
      readonly purpose: JobPurpose
      readonly run: EndedAutomationRun
    }

interface ShownFacts {
  readonly repeats?: boolean
  readonly news?: boolean
  readonly changed?: boolean
  readonly twinExists?: boolean
  readonly recurring?: boolean
  readonly cancelledTask?: boolean
}

const shown = (
  record: Readable,
  {
    twinExists = false,
    recurring = false,
    cancelledTask = false,
    repeats = false,
    news = false,
    changed = false
  }: ShownFacts = {}
): boolean => {
  if (!told(record) || twinExists) return false
  switch (record.purpose) {
    case "chat":
      return record.status === "finished" || record.status === "failed"
    case "user_automation":
      return record.status !== "finished" || !repeats || news || changed
    case "task_execution":
      return (
        (record.status === "finished" && cancelledTask && !recurring) ||
        (record.status === "blocked" && waitsOnOwner(record.detail))
      )
    case "system":
    case "space_review":
      return false
  }
}

export const tellShown = (record: Pick<Readable, "purpose" | "placeKind">): boolean =>
  record.placeKind === "chat" && record.purpose !== "system"

const DAMAGED_RUN = "The worker's record is damaged, so its result could not be read."

export const workerNames = {
  code: "Code worker",
  research: "Research worker",
  work: "Worker"
} as const

export const recordEnding = Effect.fn("RunEnding.record")(function* (
  sql: SqlClient.SqlClient,
  ending: Ending
) {
  const runId = ending.kind === "run" ? ending.runId : ending.run.chatRunId
  if (runId === null) return undefined
  const loaded = yield* readRun(sql, runId)
  if (loaded === undefined) return undefined
  const { source, contextError } = loaded
  const origin: RunOrigin | undefined =
    contextError === undefined ? (loaded.context?.origin ?? { kind: "unrecorded" }) : undefined
  const owned = origin?.kind === "automation" || origin?.kind === "task" || origin?.kind === "space"
  const belongsTo = contextError === undefined ? loaded.context?.belongs_to : undefined
  const work = belongsTo ?? origin
  const { place, agent } = yield* placeOf(sql, {
    runId,
    sessionId: source.session_id,
    origin,
    belongsTo
  })
  const damaged = contextError !== undefined && agent !== undefined
  const context: RunContext | undefined = damaged
    ? { origin: { kind: "chat", session_id: agent.parent, turn_id: "unrecorded" }, task: null }
    : loaded.context
  const purpose: Purpose =
    ending.kind === "occurrence" ? ending.purpose : yield* purposeOf(sql, work)
  const facts = yield* factsOf(sql, runId)
  const plain = damaged
    ? saidDamaged(ending)
    : saidOf({ ending, purpose, facts, agent: agent !== undefined })
  const twinExists = yield* entityTwinAt(sql, runId, place)
  const ownTask = purpose === "task_execution" && work?.kind === "task" ? work : undefined
  const recurring =
    ownTask === undefined ? false : yield* taskDoneBefore(sql, ownTask.item_id, runId)
  const cancelledTask =
    ownTask === undefined
      ? false
      : (yield* sql`SELECT 1 FROM space_task_events
          WHERE item_id = ${ownTask.item_id} AND run_ref = ${runId} AND event_type = 'cancelled'
          LIMIT 1`).length > 0
  const finished =
    plain.status === "finished" || (plain.status === "silent" && plain.detail === "empty")
  const added =
    finished && ownTask !== undefined ? yield* wakeAdded(sql, ownTask.item_id, runId) : []
  const step = added.length > 0
  const said: Said = step
    ? { status: "finished", detail: "step", text: plain.text.trim() || added.join("\n") }
    : plain
  const base = {
    runId,
    purpose,
    status: said.status,
    detail: said.detail,
    text: said.text,
    place: place.sessionId ?? null,
    placeKind: place.kind,
    occurredAt: ending.kind === "run" ? (ending.occurredAt ?? ending.now) : ending.run.endedAt,
    decided: ending.kind === "occurrence" || !owned
  }
  const repeats = purpose === "user_automation" && (yield* automationRunRepeats(sql, runId))
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
      ${record.decided ? 1 : 0}, ${contextError ?? null})
    ON CONFLICT(run_id) DO UPDATE SET purpose = excluded.purpose, status = excluded.status,
      detail = excluded.detail, text = excluded.text, place = excluded.place,
      place_kind = excluded.place_kind, occurred_at = excluded.occurred_at,
      shown = excluded.shown, decided = excluded.decided,
      delivery_error = excluded.delivery_error
    WHERE run_endings.decided = 0
    RETURNING run_id`
  if (ending.kind === "occurrence") yield* decideOccurrenceEndings(sql, ending.run)
  if (stored.length === 0 || !record.decided) return record
  yield* deliver(sql, {
    record,
    place,
    source,
    context,
    origin: damaged ? context?.origin : work,
    mode: agent?.mode,
    now: ending.kind === "run" ? ending.now : ending.run.endedAt
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

const purposeOf = Effect.fn("RunEnding.purpose")(function* (
  sql: SqlClient.SqlClient,
  origin: RunOrigin | undefined
): Effect.fn.Return<Purpose, SqlError> {
  if (origin === undefined) return "chat"
  switch (origin.kind) {
    case "task":
      return "task_execution"
    case "space":
      return "space_review"
    case "chat":
    case "unrecorded":
      return "chat"
    case "automation": {
      const rows = yield* sql<{ readonly purpose: string }>`SELECT purpose FROM scheduled_tasks
        WHERE task_id = ${origin.automation_id}`
      return isUserAutomationPurpose(rows[0]?.purpose) ? "user_automation" : "system"
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
  }>`SELECT automation.triggers, json_extract(attempt.trigger_json, '$.source') AS source,
      EXISTS (SELECT 1 FROM automation_runs AS earlier
        WHERE earlier.task_id = attempt.task_id AND earlier.id < attempt.id
          AND COALESCE(json_extract(earlier.trigger_json, '$.source'), '') <> 'manual') AS again
    FROM automation_runs AS attempt
    JOIN scheduled_tasks AS automation ON automation.task_id = attempt.task_id
    WHERE attempt.chat_run_id = ${runId}
    ORDER BY attempt.id DESC LIMIT 1`
  const row = rows[0]
  if (row === undefined || row.source === "manual") return false
  return (
    row.again === 1 || (row.triggers !== null && automationRepeats(storedTriggers(row.triggers)))
  )
})

const storedTriggers = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const entityTwinAt = Effect.fn("RunEnding.twin")(function* (
  sql: SqlClient.SqlClient,
  runId: string,
  place: Place
) {
  if (place.kind !== "chat") return false
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
    const decided = yield* sql<{
      readonly purpose: Purpose
      readonly status: EndingStatus
      readonly detail: string | null
      readonly text: string
      readonly place: string | null
      readonly place_kind: PlaceKind
      readonly occurred_at: string
      readonly shown: number
    }>`UPDATE run_endings SET decided = 1 WHERE run_id = ${runId} AND decided = 0
      RETURNING purpose, status, detail, text, place, place_kind, occurred_at, shown`
    const row = decided[0]
    if (row === undefined) continue
    const record: EndingRecord = {
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
    }
    yield* deliverStored(sql, record).pipe(
      Effect.catch((cause) => keepError(sql, runId, cause)),
      Effect.catchDefect((defect) => keepError(sql, runId, defect))
    )
  }
})

export const placeOfRun = Effect.fn("RunEnding.placeOfRun")(function* (
  sql: SqlClient.SqlClient,
  runId: string
) {
  const loaded = yield* readRun(sql, runId)
  if (loaded === undefined) return undefined
  const origin: RunOrigin | undefined =
    loaded.contextError === undefined
      ? (loaded.context?.origin ?? { kind: "unrecorded" })
      : undefined
  const belongsTo = loaded.contextError === undefined ? loaded.context?.belongs_to : undefined
  const work = belongsTo ?? origin
  const { place, agent } = yield* placeOf(sql, {
    runId,
    sessionId: loaded.source.session_id,
    origin,
    belongsTo
  })
  const damaged = loaded.contextError !== undefined && agent !== undefined
  const context: RunContext | undefined = damaged
    ? { origin: { kind: "chat", session_id: agent.parent, turn_id: "unrecorded" }, task: null }
    : loaded.context
  return {
    place,
    agent,
    source: loaded.source,
    context,
    origin: damaged ? context?.origin : work,
    purpose: yield* purposeOf(sql, work)
  }
})

const deliverStored = Effect.fn("RunEnding.deliverStored")(function* (
  sql: SqlClient.SqlClient,
  record: EndingRecord
) {
  const placed = yield* placeOfRun(sql, record.runId)
  if (placed === undefined) return
  yield* deliver(sql, {
    record,
    place: placed.place,
    source: placed.source,
    context: placed.context,
    origin: placed.origin,
    mode: placed.agent?.mode,
    now: record.occurredAt
  })
})

interface Facts {
  readonly quiet: boolean
  readonly news: boolean
  readonly changed: boolean
  readonly ask: string | null
  readonly askLine: string
  readonly blockedKind: string | null
}

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

interface Said {
  readonly status: EndingStatus
  readonly detail: string | null
  readonly text: string
}

const silent = (detail: string, text = ""): Said => ({ status: "silent", detail, text })

const saidOf = (input: {
  readonly ending: Ending
  readonly purpose: Purpose
  readonly facts: Facts
  readonly agent: boolean
}): Said => {
  const { ending } = input
  if (ending.kind === "run") return saidOfRun(ending.terminal, input.agent, input.facts)
  return saidOfOccurrence(ending.run, input.purpose, input.facts)
}

const saidOfRun = (terminal: RunTerminal, agent: boolean, facts: Facts): Said => {
  switch (terminal.status) {
    case "cancelled":
      return { status: "cancelled", detail: null, text: agent ? "Worker cancelled." : "" }
    case "failed":
      return terminal.error.trim() === "" && !agent
        ? silent("empty")
        : { status: "failed", detail: null, text: terminal.error }
    case "completed":
      if (facts.ask !== null)
        return {
          status: "waiting",
          detail: facts.ask,
          text: agent ? `Waiting for the owner's answer: ${facts.askLine}` : terminal.result
        }
      if (facts.quiet) return silent("no_change", terminal.result)
      if (terminal.result.trim() === "") return silent("empty")
      return { status: "finished", detail: null, text: terminal.result }
  }
}

const saidOfOccurrence = (run: EndedAutomationRun, purpose: Purpose, facts: Facts): Said => {
  switch (run.outcome) {
    case "failed":
      return { status: "failed", detail: null, text: run.error ?? run.result ?? "The run failed." }
    case "finished":
      if (facts.ask !== null)
        return { status: "waiting", detail: facts.ask, text: run.result ?? "" }
      return run.result === null || run.result.trim() === ""
        ? silent("empty")
        : { status: "finished", detail: null, text: run.result }
    case "blocked":
      return run.result === null || run.result.trim() === ""
        ? silent("empty")
        : { status: "blocked", detail: facts.blockedKind, text: run.result }
    case "needs_you":
      if (facts.ask !== null)
        return { status: "waiting", detail: facts.ask, text: run.result ?? "" }
      return isUserAutomationPurpose(purpose) || purpose === "task_execution"
        ? { status: "blocked", detail: "needs_you", text: run.result ?? "" }
        : silent("needs_you", run.result ?? "")
    case "cancelled":
      return { status: "cancelled", detail: null, text: "" }
    case "no_change":
    case "interrupted":
    case "superseded":
    case "skipped:prefilter":
    case "skipped:space_review_gate":
      return silent(run.outcome, run.result ?? "")
  }
}

const saidDamaged = (ending: Ending): Said => {
  const terminal: RunTerminal =
    ending.kind === "run" ? ending.terminal : { status: "failed", error: "" }
  switch (terminal.status) {
    case "cancelled":
      return { status: "cancelled", detail: "damaged", text: DAMAGED_RUN }
    case "failed":
      return {
        status: "failed",
        detail: "damaged",
        text: `${DAMAGED_RUN} ${terminal.error}`.trim()
      }
    case "completed":
      return { status: "finished", detail: "damaged", text: DAMAGED_RUN }
  }
}

export const toldOutcomeOf = (
  record: EndingRecord | undefined,
  run: EndedAutomationRun
): { readonly outcome: ToldOutcome; readonly text: string } | undefined => {
  if (record === undefined)
    return run.outcome === "failed"
      ? { outcome: "failed", text: run.error ?? run.result ?? "The run failed." }
      : undefined
  switch (record.status) {
    case "finished":
      return { outcome: "finished", text: record.text }
    case "blocked":
      return { outcome: record.detail === "needs_you" ? "needs_you" : "blocked", text: record.text }
    case "waiting":
      return { outcome: "needs_you", text: record.text }
    case "failed":
      return { outcome: "failed", text: record.text }
    case "silent":
      return record.detail === "empty" && (run.outcome === "finished" || run.outcome === "blocked")
        ? { outcome: run.outcome, text: "" }
        : undefined
    case "cancelled":
      return undefined
  }
}

const deliver = Effect.fn("RunEnding.deliver")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly record: EndingRecord
    readonly place: Place
    readonly source: SourceRunRow
    readonly context: RunContext | undefined
    readonly origin: RunOrigin | undefined
    readonly mode: ChildAgent["mode"] | undefined
    readonly now: string
  }
) {
  const { record, place, source, context } = input
  if (record.purpose === "task_execution" && input.origin?.kind === "task")
    yield* tellCriteriaMet(sql, {
      runId: record.runId,
      itemId: input.origin.item_id,
      place,
      source,
      occurredAt: record.occurredAt
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("A met criterion was not told", cause)),
      Effect.catchDefect((defect) => Effect.logWarning("A met criterion was not told", defect))
    )
  if (record.placeKind === "parent") {
    if (context === undefined || record.place === null || input.mode === undefined)
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
      subject: `${workerNames[input.mode]} ${report.label}`,
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
  if (place.kind !== "chat" || context === undefined || input.origin === undefined)
    return yield* Effect.fail(new Error("The ending has no chat to be told in"))
  if (record.purpose === "task_execution" && (yield* oldPollTold(sql, record.runId))) return
  yield* tellChat({
    sql,
    weight,
    occurrenceKey: `ending:run:${record.runId}`,
    source: { kind: "ending", runId: record.runId },
    sourceRunId: record.runId,
    sourceSessionRef: source.source_ref,
    destination: place.row,
    line: record.text,
    door: yield* doorOf(sql, input.origin, source, context),
    event:
      record.status === "finished" && record.detail === "step"
        ? "told"
        : arrivalEvent(record.status),
    occurredAt: record.occurredAt
  })
})

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
  if (wake.place.kind === "own") destination = yield* chatRow(sql, wake.place.sessionId)
  if (destination === undefined) {
    yield* Effect.logInfo("A met criterion has no chat to be told in", wake.itemId)
    return
  }
  const weight = updateWeight({ kind: "met", shown: wake.place.kind === "chat" })
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
    case "blocked":
      return "blocked"
    case "failed":
      return "failed"
    case "finished":
    case "cancelled":
    case "silent":
    case "waiting":
      return "finished"
  }
}

export const doorOf = Effect.fn("RunEnding.door")(function* (
  sql: SqlClient.SqlClient,
  origin: RunOrigin,
  source: SourceRunRow,
  context: RunContext
): Effect.fn.Return<CommunicationDoor, SqlError> {
  if (origin.kind === "task") {
    const task = (yield* sql<{ readonly text: string }>`SELECT text FROM space_tasks
      WHERE item_id = ${origin.item_id}`)[0]
    return taskDoor(origin.item_id, task?.text ?? "Task")
  }
  return yield* runDoor(sql, "Open run", source, context)
})

const readRun = Effect.fn("RunEnding.readRun")(function* (sql: SqlClient.SqlClient, runId: string) {
  const rows = yield* sql<SourceRunRow & { readonly context: string | null }>`
    SELECT run.run_id, run.session_id, run.status, session.public_ref AS source_ref,
      session.name AS source_name, json_extract(run.metadata_json, '$.run_context') AS context_json,
      json_extract(run.metadata_json, '$.run_context') AS context
    FROM chat_runs AS run JOIN sessions AS session ON session.session_id = run.session_id
    WHERE run.run_id = ${runId}`
  const row = rows[0]
  if (row === undefined) return undefined
  if (row.context === null) return { source: row, context: undefined, contextError: undefined }
  const decoded = yield* decodeJson(RunContextSchema, row.context).pipe(Effect.result)
  return decoded._tag === "Success"
    ? { source: row, context: decoded.success, contextError: undefined }
    : { source: row, context: undefined, contextError: "The run's context is corrupt" }
})
