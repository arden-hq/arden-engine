import type { CommunicationDoor } from "@arden-hq/protocol/chat"
import { DateTime, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { serializeOperationalCause } from "../../runtime/operational-events.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { announceNotice } from "./notices.js"
import { taskDoor } from "./ending-arrival.js"
import { entityWeight, tellChat } from "./owner-update.js"
import { entityPlaces, type ChatPlace, type Place } from "./run-destination.js"
import { userAutomationSql } from "./authority-sql.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { failedRunStatusList, restartCutRunSql } from "./status-sets.js"

interface EntityEvent {
  readonly key: string
  readonly entity: "task" | "automation"
  readonly entityId: string
  readonly event: "done" | "paused" | "failed"
  readonly runId: string | null
  readonly text: string
  readonly places: ReadonlyArray<Place>
  readonly occurredAt: string
  readonly ownSession: string | null
  readonly shown: boolean
}

const placeKind = (
  first: Place | undefined,
  ownSession: string | null
): "own" | "chat" | "gone" => {
  if (first === undefined || first.kind === "gone") return "gone"
  return first.sessionId === ownSession ? "own" : "chat"
}

export type EntityFact =
  | {
      readonly entity: "task"
      readonly event: "done"
      readonly result: string
      readonly recurring: boolean
    }
  | {
      readonly entity: "task"
      readonly event: "failed"
      readonly text: string
      readonly retryPending: boolean
    }
  | { readonly entity: "automation"; readonly event: "failed" | "paused" }

const entityShown = (fact: EntityFact): boolean => {
  switch (fact.entity) {
    case "automation":
      return true
    case "task":
      switch (fact.event) {
        case "done":
          return fact.result.trim() !== "" && !fact.recurring
        case "failed":
          return fact.text.trim() !== "" && !fact.retryPending
      }
  }
}

export const taskDoneBefore = Effect.fn("EntityEvents.doneBefore")(function* (
  sql: SqlClient.SqlClient,
  itemId: string,
  runId: string
) {
  const rows = yield* sql`SELECT 1 FROM space_task_events
    WHERE item_id = ${itemId} AND event_type = 'done' AND (run_ref IS NULL OR run_ref <> ${runId})
      AND event_id > COALESCE((SELECT MAX(event_id) FROM space_task_events
        WHERE item_id = ${itemId} AND event_type IN ('reopened', 'unblocked')), 0)
    LIMIT 1`
  return rows.length > 0
})

const recordEntityEvent = Effect.fn("EntityEvents.record")(function* (
  sql: SqlClient.SqlClient,
  sessionEvents: SessionLifecycleEvents["Service"],
  event: EntityEvent,
  draw: (place: ChatPlace, occurrenceKey: string) => Effect.Effect<void, unknown>
) {
  const [first] = event.places
  const kind = placeKind(first, event.ownSession)
  const stored = yield* sql`INSERT INTO entity_events (key, entity, entity_id, event, run_id, text,
      place, place_kind, occurred_at, shown, delivery_error)
    VALUES (${event.key}, ${event.entity}, ${event.entityId}, ${event.event}, ${event.runId},
      ${event.text}, ${first?.sessionId ?? null}, ${kind},
      ${event.occurredAt}, ${event.shown ? 1 : 0}, NULL)
    ON CONFLICT(key) DO NOTHING RETURNING key`
  if (stored.length === 0) return
  yield* announceNotice(sql, sessionEvents, event.key)
  if (kind === "own" || kind === "gone") return
  yield* Effect.forEach(event.places, (place) =>
    place.kind === "chat" ? draw(place, `entity:${event.key}:${place.sessionId}`) : Effect.void
  ).pipe(
    Effect.catch(
      (cause) =>
        sql`UPDATE entity_events SET delivery_error = ${serializeOperationalCause(cause)} WHERE key = ${event.key}`
    ),
    Effect.asVoid
  )
})

export const recordTaskDone = Effect.fn("EntityEvents.taskDone")(function* (
  sql: SqlClient.SqlClient,
  sessionEvents: SessionLifecycleEvents["Service"],
  eventId: number
) {
  const rows = yield* sql<{
    readonly item_id: string
    readonly run_ref: string
    readonly line: string
    readonly result: string | null
    readonly created_at: string
    readonly title: string
    readonly source_ref: string | null
    readonly source_session: string | null
  }>`SELECT event.item_id, event.run_ref, COALESCE(event.result_summary, event.summary) AS line,
      event.result_summary AS result, event.created_at, task.text AS title, source.public_ref AS source_ref,
      source.session_id AS source_session
    FROM space_task_events AS event
    JOIN space_tasks AS task ON task.item_id = event.item_id
    LEFT JOIN chat_runs AS run ON run.run_id = event.run_ref
    LEFT JOIN sessions AS source ON source.session_id = run.session_id
    WHERE event.event_id = ${eventId} AND event.event_type = 'done' AND event.run_ref IS NOT NULL`
  const done = rows[0]
  if (done === undefined) return
  const places = yield* entityPlaces(sql, { kind: "task", itemId: done.item_id })
  const fact: EntityFact = {
    entity: "task",
    event: "done",
    result: done.result ?? "",
    recurring: yield* taskDoneBefore(sql, done.item_id, done.run_ref)
  }
  const shown = entityShown(fact)
  const weight = entityWeight(fact, shown)
  yield* recordEntityEvent(
    sql,
    sessionEvents,
    {
      key: `task-done:${eventId}`,
      entity: "task",
      entityId: done.item_id,
      event: "done",
      runId: done.run_ref,
      text: done.line,
      places,
      occurredAt: done.created_at,
      ownSession: done.source_session,
      shown
    },
    (place) =>
      tellChat({
        sql,
        weight,
        occurrenceKey: `task-event:${eventId}`,
        source: { kind: "entity", key: `task-done:${eventId}` },
        sourceRunId: done.run_ref,
        sourceSessionRef: done.source_ref ?? place.row.public_ref,
        destination: place.row,
        line: done.line,
        door: taskDoor(done.item_id, done.title),
        event: "finished",
        occurredAt: done.created_at
      })
  )
})

export const recordTaskFailed = Effect.fn("EntityEvents.taskFailed")(function* (
  sql: SqlClient.SqlClient,
  sessionEvents: SessionLifecycleEvents["Service"],
  eventId: number
) {
  const rows = yield* sql<{
    readonly item_id: string
    readonly run_ref: string
    readonly line: string
    readonly next_attempt_at: string | null
    readonly created_at: string
    readonly title: string
    readonly source_ref: string | null
    readonly source_session: string | null
    readonly run_failed: number
    readonly restart_cut: number
  }>`SELECT event.item_id, event.run_ref, event.summary AS line, task.next_attempt_at,
      event.created_at, task.text AS title, source.public_ref AS source_ref,
      source.session_id AS source_session,
      COALESCE(run.status IN ${failedRunStatusList}, 0) AS run_failed,
      COALESCE(${restartCutRunSql("run")}, 0) AS restart_cut
    FROM space_task_events AS event
    JOIN space_tasks AS task ON task.item_id = event.item_id
    LEFT JOIN chat_runs AS run ON run.run_id = event.run_ref
    LEFT JOIN sessions AS source ON source.session_id = run.session_id
    WHERE event.event_id = ${eventId} AND event.event_type = 'failed' AND event.run_ref IS NOT NULL`
  const failed = rows[0]
  if (failed === undefined || failed.restart_cut === 1) return
  const places = yield* entityPlaces(sql, { kind: "task", itemId: failed.item_id })
  const fact: EntityFact = {
    entity: "task",
    event: "failed",
    text: failed.line,
    retryPending: failed.next_attempt_at !== null
  }
  const shown = entityShown(fact)
  const weight = entityWeight(fact, shown)
  yield* recordEntityEvent(
    sql,
    sessionEvents,
    {
      key: `task-failed:${eventId}`,
      entity: "task",
      entityId: failed.item_id,
      event: "failed",
      runId: failed.run_ref,
      text: failed.line,
      places,
      occurredAt: failed.created_at,
      ownSession: failed.run_failed === 1 ? failed.source_session : null,
      shown
    },
    (place, occurrenceKey) =>
      tellChat({
        sql,
        weight,
        occurrenceKey,
        source: { kind: "entity", key: `task-failed:${eventId}` },
        sourceRunId: failed.run_ref,
        sourceSessionRef: failed.source_ref ?? place.row.public_ref,
        destination: place.row,
        line: failed.line,
        door: taskDoor(failed.item_id, failed.title),
        event: "failed",
        occurredAt: failed.created_at
      })
  )
})

interface PausePayload {
  readonly kind: "automation_paused"
  readonly attemptId: number
  readonly resumedAt: string | null
}

export const recordAutomationEvent = Effect.fn("EntityEvents.automation")(function* (
  sql: SqlClient.SqlClient,
  options: {
    readonly sessionEvents: SessionLifecycleEvents["Service"]
    readonly automationId: string
    readonly attemptId: number
    readonly event: "failed" | "paused"
    readonly text: string
  }
) {
  const automation = (yield* sql<{
    readonly name: string
    readonly automation_ref: string
    readonly context_mode: string
  }>`SELECT name, automation_ref, context_mode FROM scheduled_tasks
    WHERE task_id = ${options.automationId} AND ${userAutomationSql()}`)[0]
  if (automation === undefined) return
  const ended = (yield* sql<{ readonly ended_at: string | null }>`
    SELECT ended_at FROM automation_runs WHERE id = ${options.attemptId}`)[0]
  const at = ended?.ended_at ?? DateTime.formatIso(yield* DateTime.now)
  if (options.event === "paused") {
    const payload: PausePayload = {
      kind: "automation_paused",
      attemptId: options.attemptId,
      resumedAt: null
    }
    yield* sql`INSERT INTO automation_deliveries (
        delivery_id, task_id, delivered_at, subject, body, payload, status, created_at, destinations
      ) VALUES (
        ${sha256Hex(`automation-paused:${options.attemptId}`)}, ${options.automationId}, ${at},
        'paused', ${options.text}, ${JSON.stringify(payload)}, 'delivered', ${at}, '[]'
      ) ON CONFLICT(delivery_id) DO NOTHING`
  }
  const places = yield* entityPlaces(sql, {
    kind: "automation",
    automationId: options.automationId,
    ownChats: options.event === "paused" && automation.context_mode === "fresh"
  })
  const door = {
    kind: "automation",
    label: automation.name.trim().slice(0, 160),
    automation_ref: automation.automation_ref,
    href: `arden:automation/${encodeURIComponent(automation.automation_ref)}`
  } satisfies CommunicationDoor
  const fact: EntityFact = { entity: "automation", event: options.event }
  const shown = entityShown(fact)
  const weight = entityWeight(fact, shown)
  yield* recordEntityEvent(
    sql,
    options.sessionEvents,
    {
      key: `automation-${options.event}:${options.attemptId}`,
      entity: "automation",
      entityId: options.automationId,
      event: options.event,
      runId: null,
      text: options.text,
      places,
      occurredAt: at,
      ownSession: null,
      shown
    },
    (place, occurrenceKey) =>
      tellChat({
        sql,
        weight,
        occurrenceKey,
        source: { kind: "entity", key: `automation-${options.event}:${options.attemptId}` },
        sourceRunId: `automation-run:${options.attemptId}`,
        sourceSessionRef: place.row.public_ref,
        destination: place.row,
        line: options.text,
        door,
        event: options.event,
        occurredAt: at
      })
  )
})
