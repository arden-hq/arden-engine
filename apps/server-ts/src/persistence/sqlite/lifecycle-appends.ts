import { SERVER_EVENT_TYPE } from "@arden-hq/protocol"
import { RUN_STATUS } from "@arden-hq/protocol/runs"
import { TASK_STATUS } from "@arden-hq/protocol/spaces/work"
import { taskSpace } from "./event-links.js"
import type { AutomationEvent, RuntimeRunStatus, TaskWorkChangedEvent } from "@arden-hq/protocol"
import type { SpaceTaskStatus } from "@arden-hq/protocol/spaces/work"
import { AutomationEventSchema, TaskWorkChangedEventSchema } from "@arden-hq/protocol/effect/events"
import {
  appendInTransaction as appendJournalInTransaction,
  type JournalAppendResult,
  type JournalRuntime,
  type JournalEvent
} from "@arden-hq/journal/effect"
import { Effect, Schema } from "effect"
import { archivedChatAppend, lifecycleError } from "./lifecycle-archived.js"
import { SqlClient } from "effect/unstable/sql"
import {
  SESSION_LIFECYCLE_STREAM_ID,
  SessionLifecycleEventError,
  type SessionLifecycleEventType
} from "../sessions/events.js"
import {
  InternalLifecycleEventSchema,
  type InternalLifecycleEvent
} from "../sessions/internal-events.js"
import { sessionBlockingWorkPredicate } from "./session-blocking-work.js"
import { loadSessionSnapshot } from "./session-snapshot.js"
import type { PersistenceDeps } from "./deps.js"
import { toldKey, UnitOfWork } from "../unit-of-work.js"
import { touchedThrough } from "./tells/capture.js"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"

interface TaskWorkRow {
  readonly space_id: string | null
  readonly item_id: string
  readonly task_name: string
  readonly task_status: SpaceTaskStatus
  readonly session_id: string
  readonly run_id: string
  readonly run_status: RuntimeRunStatus
  readonly started_at: string
  readonly ended_at: string | null
}

const loadSessionBlockingWork = Effect.fn("SessionLifecycleEvents.loadSessionBlockingWork")(
  function* (sql: SqlClient.SqlClient, sessionId: string) {
    const rows = yield* sql<{ readonly blocking_work: number }>`
      SELECT ${sessionBlockingWorkPredicate(sql)} AS blocking_work
      FROM sessions AS s
      WHERE s.session_id = ${sessionId}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        lifecycleError("append", "Could not read Session blocking-work state", cause)
      )
    )
    const row = rows[0]
    if (row === undefined) {
      return yield* lifecycleError("append", "Session does not exist")
    }
    return row.blocking_work !== 0
  }
)

const TASK_WORK_TARGET = { session: "session", item: "item" } as const

export const loadTaskWork = Effect.fn("SessionLifecycleEvents.loadTaskWork")(function* (
  sql: SqlClient.SqlClient,
  target:
    | { readonly kind: typeof TASK_WORK_TARGET.session; readonly id: string }
    | {
        readonly kind: typeof TASK_WORK_TARGET.item
        readonly id: string
      }
): Effect.fn.Return<TaskWorkChangedEvent | undefined, SessionLifecycleEventError> {
  const targetPredicate =
    target.kind === TASK_WORK_TARGET.session
      ? sql`run.session_id = ${target.id}`
      : sql`task.item_id = ${target.id}
          AND json_extract(run.metadata_json, '$.run_context.task.item_id') = ${target.id}`
  const rows = yield* sql<TaskWorkRow>`
    SELECT task.space_id, task.item_id, task.text AS task_name,
      task.status AS task_status,
      run.session_id, run.run_id, run.status AS run_status,
      run.started_at, run.ended_at
    FROM chat_runs AS run
    JOIN space_tasks AS task
      ON task.item_id = json_extract(run.metadata_json, '$.run_context.task.item_id')
    WHERE ${targetPredicate}
    ORDER BY run.updated_at DESC, run.started_at DESC, run.run_id DESC
    LIMIT 1
  `.pipe(
    Effect.mapError((cause) => lifecycleError("append", "Could not read Task live work", cause))
  )
  const row = rows[0]
  if (row === undefined) return undefined
  const common = {
    type: "task_work_changed" as const,
    space: taskSpace(row.space_id),
    item_id: row.item_id,
    task_name: row.task_name,
    run_session_id: row.session_id,
    chat_run_id: row.run_id,
    started_at: row.started_at
  }
  const phase = isActiveRunStatus(row.run_status) ? row.run_status : undefined
  const candidate =
    phase !== undefined
      ? {
          ...common,
          state: "running" as const,
          phase,
          ended_at: null,
          outcome: null
        }
      : {
          ...common,
          state: "ended" as const,
          phase: "ended" as const,
          ended_at: row.ended_at,
          outcome: endedTaskWorkOutcome(row)
        }
  return yield* Schema.decodeUnknownEffect(TaskWorkChangedEventSchema)(candidate).pipe(
    Effect.mapError((cause) => lifecycleError("append", "Stored Task live work is corrupt", cause))
  )
})

const endedTaskWorkOutcome = (
  row: Pick<TaskWorkRow, "task_status" | "run_status">
): "finished" | "failed" | "stopped" => {
  if (row.task_status === TASK_STATUS.done) return "finished"
  if (row.task_status !== TASK_STATUS.open || row.run_status === RUN_STATUS.cancelled)
    return "stopped"
  return row.run_status === RUN_STATUS.completed ? "finished" : "failed"
}

export const LifecycleRecordSchema = Schema.Union([
  AutomationEventSchema,
  InternalLifecycleEventSchema
])

const encodeLifecycleEvent = Schema.encodeEffect(Schema.toCodecJson(LifecycleRecordSchema))

export const journalEvent = (
  event: AutomationEvent | InternalLifecycleEvent,
  options: { readonly live?: true } = {}
): Effect.Effect<JournalEvent, SessionLifecycleEventError> =>
  encodeLifecycleEvent(event).pipe(
    Effect.map((data) => ({
      type: event.type,
      data,
      ...(options.live === true ? { durable: false } : {})
    })),
    Effect.mapError((cause) =>
      lifecycleError("append", "Session lifecycle event cannot be encoded", cause)
    )
  )

export interface LifecycleAppends {
  readonly afterCommit: (committed: JournalAppendResult) => Effect.Effect<void, never, UnitOfWork>
  readonly appendInTransaction: (
    type: SessionLifecycleEventType,
    sessionId: string
  ) => Effect.Effect<JournalAppendResult, SessionLifecycleEventError, UnitOfWork>
  readonly appendBlockingWorkInTransaction: (
    sessionId: string
  ) => Effect.Effect<JournalAppendResult, SessionLifecycleEventError, UnitOfWork>
}

export const makeLifecycleAppends = ({
  sql,
  journal
}: {
  readonly sql: PersistenceDeps["writer"]["sql"]
  readonly journal: JournalRuntime
}): LifecycleAppends => {
  const afterCommit = Effect.fn("SessionLifecycleEvents.afterCommit")(function* (
    committed: JournalAppendResult
  ) {
    const unit = yield* UnitOfWork
    yield* unit.afterCommit(journal.notify(committed))
  })
  const appendInTransaction = Effect.fn("SessionLifecycleEvents.appendInTransaction")(function* (
    type: SessionLifecycleEventType,
    sessionId: string
  ): Effect.fn.Return<JournalAppendResult, SessionLifecycleEventError, UnitOfWork> {
    const valid = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        type: Schema.Literals(["session_created", "session_activity"] as const),
        sessionId: Schema.NonEmptyString
      })
    )({ type, sessionId }).pipe(
      Effect.mapError((cause) => lifecycleError("append", "Invalid Session lifecycle event", cause))
    )
    const archived = yield* archivedChatAppend(sql, valid.sessionId)
    if (archived !== null) return archived
    const session = yield* loadSessionSnapshot(sql, valid.sessionId)
    const lifecycleEvent = yield* journalEvent({ type: valid.type, session })
    const taskWork =
      valid.type === SERVER_EVENT_TYPE.sessionActivity
        ? yield* loadTaskWork(sql, { kind: TASK_WORK_TARGET.session, id: valid.sessionId })
        : undefined
    return yield* appendJournalInTransaction(
      sql,
      SESSION_LIFECYCLE_STREAM_ID,
      taskWork === undefined ? [lifecycleEvent] : [lifecycleEvent, yield* journalEvent(taskWork)]
    ).pipe(
      Effect.mapError((cause) =>
        lifecycleError("append", "Could not append the Session lifecycle event", cause)
      ),
      Effect.tap(afterCommit),
      Effect.tap(() =>
        Effect.flatMap(Effect.all([touchedThrough(sql), UnitOfWork]), ([through, unit]) =>
          unit.markTold(toldKey.session(sessionId), through)
        )
      )
    )
  })

  const appendBlockingWorkInTransaction = Effect.fn(
    "SessionLifecycleEvents.appendBlockingWorkInTransaction"
  )(function* (
    sessionId: string
  ): Effect.fn.Return<JournalAppendResult, SessionLifecycleEventError, UnitOfWork> {
    const validSessionId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(sessionId).pipe(
      Effect.mapError((cause) =>
        lifecycleError("append", "Invalid Session blocking-work event", cause)
      )
    )
    const blockingWork = yield* loadSessionBlockingWork(sql, validSessionId)
    return yield* appendJournalInTransaction(sql, SESSION_LIFECYCLE_STREAM_ID, [
      yield* journalEvent({
        type: "session_blocking_work",
        session_id: validSessionId,
        blocking_work: blockingWork
      })
    ]).pipe(
      Effect.mapError((cause) =>
        lifecycleError("append", "Could not append the Session blocking-work event", cause)
      ),
      Effect.tap(afterCommit)
    )
  })
  return { afterCommit, appendInTransaction, appendBlockingWorkInTransaction }
}
