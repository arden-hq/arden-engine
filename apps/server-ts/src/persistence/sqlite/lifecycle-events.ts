import { withCurrentSessionActivity } from "./lifecycle-presentation.js"
import type { AutomationEvent, RuntimeRunStatus, TaskWorkChangedEvent } from "@arden-hq/protocol"
import type { SpaceTaskStatus } from "@arden-hq/protocol/spaces/work"
import {
  AutomationEventSchema,
  AutomationFinishedEventSchema,
  AutomationProgressEventSchema,
  ChatInputCommittedEventSchema,
  FocusChoiceChangedEventSchema,
  EntityChangedEventSchema,
  McpServerChangedEventSchema,
  NavigationRequestedEventSchema,
  QuestionChangedEventSchema,
  RecordToldEventSchema,
  TaskProposalChangedEventSchema,
  TaskVisibilityChangedEventSchema,
  TaskWorkChangedEventSchema,
  WorkChangedEventSchema
} from "@arden-hq/protocol/effect/events"
import { ListedSessionSchema } from "@arden-hq/protocol/effect/sessions"
import {
  appendInTransaction as appendJournalInTransaction,
  journalHeadSequenceSql,
  journalRecordsSql,
  type JournalAppendResult,
  type JournalRecord,
  type JournalRuntime
} from "@arden-hq/journal/effect"
import { DateTime, Effect, Schema, Scope, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  SESSION_LIFECYCLE_STREAM_ID,
  SessionLifecycleEventError,
  SessionLifecycleEvents,
  type LifecycleFeedEvent,
  type OpenSessionLifecycleEvents,
  type SessionLifecycleDelivery,
  type SessionLifecycleEventType,
  type StandaloneFeedEvent
} from "../sessions/events.js"
import {
  InternalLifecycleEventSchema,
  ApprovalWaitingEventSchema,
  DecisionRouteChangedEventSchema,
  AutomationChangedEventSchema,
  AutomationQueuedEventSchema,
  CaptureArrivedEventSchema,
  LimitCrossedEventSchema,
  RunSettledEventSchema,
  RunFencedEventSchema,
  TaskHistoryAddedEventSchema,
  type InternalLifecycleEvent
} from "../sessions/internal-events.js"
import { sessionBlockingWorkPredicate } from "./session-blocking-work.js"
import { latestSessionRunQuery } from "./session-latest-run.js"
import { sessionOriginQuery } from "./session-origin.js"
import { sessionPresentations } from "./session-presentation.js"
import { pendingDecisionCards } from "./pending-decision-cards.js"
import { decodeJsonWith } from "./json.js"
import { freshTriage, StoredTriageSchema } from "../sessions/triage.js"
import { StoredForkSchema } from "../sessions/fork.js"
import type { PersistenceDeps } from "./deps.js"
import { deleteJournalSequences, scanJournalWindows } from "./journal-windows.js"
import { toldKey, UnitOfWork } from "../unit-of-work.js"
import { touchedThrough } from "./tells/capture.js"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"

interface SessionListRow {
  readonly session_id: string
  readonly public_ref: string
  readonly started_at: string
  readonly last_activity: string
  readonly last_accessed_at: string | null
  readonly name: string | null
  readonly message_count: number
  readonly space_id: string | null
  readonly chat_model: string | null
  readonly session_type: string | null
  readonly origin_automation_id: string | null
  readonly parent_session_id: string | null
  readonly parent_run_id: string | null
  readonly parent_tool_call_id: string | null
  readonly parent_message_id: string | null
  readonly has_unread: number
  readonly latest_event_seq: number
  readonly checkpoint_seq: number
  readonly run_id: string | null
  readonly run_turn_id: string | null
  readonly run_status: RuntimeRunStatus | null
  readonly run_error_code: string | null
  readonly run_stop_reason: string | null
  readonly pending_approvals_count: number
  readonly pending_connections_count: number
  readonly triage_json: string | null
  readonly fork_json: string | null
  readonly thread_source_id: string | null
  readonly thread_source_ref: string | null
  readonly origin: "capture" | "onboarding" | null
}

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

const lifecycleError = (
  operation: SessionLifecycleEventError["operation"],
  message: string,
  cause?: unknown
): SessionLifecycleEventError =>
  new SessionLifecycleEventError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const loadSessionSnapshot = Effect.fn("SessionLifecycleEvents.loadSessionSnapshot")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
) {
  const rows = yield* sql<SessionListRow>`
    SELECT s.session_id, s.public_ref, s.started_at, s.last_activity,
           s.last_accessed_at, s.name,
           s.visible_message_count AS message_count, s.space_id, s.chat_model,
           s.session_type, s.origin_automation_id, s.parent_session_id,
           s.parent_run_id, s.parent_tool_call_id, s.parent_message_id,
           s.has_unread,
           json_extract(s.metadata, '$.triage') AS triage_json,
           json_extract(s.metadata, '$.fork') AS fork_json,
           json_extract(s.metadata, '$.thread.source_session_id') AS thread_source_id,
           (SELECT source.public_ref FROM sessions AS source
             WHERE source.session_id = json_extract(s.metadata, '$.thread.source_session_id')
           ) AS thread_source_ref,
           ${sql.literal(sessionOriginQuery)} AS origin,
           COALESCE(${journalHeadSequenceSql(sql, sql.literal("s.session_id"))}, 0) AS latest_event_seq,
           COALESCE((
             SELECT checkpoint_seq FROM session_event_checkpoints
             WHERE session_id = s.session_id
           ), 0) AS checkpoint_seq,
           latest_run.run_id AS run_id,
           json_extract(latest_run.metadata_json, '$.turn_id') AS run_turn_id,
           latest_run.status AS run_status,
           latest_run.error_code AS run_error_code,
           latest_run.stop_reason AS run_stop_reason,
           (
             SELECT COUNT(*) FROM (${pendingDecisionCards(sql)}) AS pending_approval
             WHERE pending_approval.session_id = s.session_id
               AND COALESCE(
                 json_extract(pending_approval.payload_json, '$.approval_data._tag'),
                 ''
               ) != 'ConnectionRequired'
           ) AS pending_approvals_count,
           (
             SELECT COUNT(*) FROM (${pendingDecisionCards(sql)}) AS pending_connection
             WHERE pending_connection.session_id = s.session_id
               AND json_extract(
                 pending_connection.payload_json,
                 '$.approval_data._tag'
               ) = 'ConnectionRequired'
           ) AS pending_connections_count
    FROM sessions AS s
    LEFT JOIN chat_runs AS latest_run
      ON latest_run.run_id = (${sql.literal(latestSessionRunQuery)})
    WHERE s.session_id = ${sessionId} AND s.archived_at IS NULL
    LIMIT 1
  `.pipe(
    Effect.mapError((cause) =>
      lifecycleError("append", "Could not read the Session lifecycle snapshot", cause)
    )
  )
  const row = rows[0]
  if (row === undefined) {
    return yield* lifecycleError("append", "Session lifecycle snapshot does not exist")
  }
  if (row.run_id !== null && (row.run_turn_id === null || row.run_turn_id.length === 0)) {
    return yield* lifecycleError("append", `Stored Chat run ${row.run_id} has no durable turn id`)
  }
  const isActive = row.run_status !== null && isActiveRunStatus(row.run_status)
  const presentations = yield* sessionPresentations(sql, [sessionId]).pipe(
    Effect.mapError((cause) => lifecycleError("append", "Could not classify Session", cause))
  )
  const triage =
    row.triage_json === null
      ? undefined
      : yield* decodeJsonWith(StoredTriageSchema, row.triage_json, (cause) =>
          lifecycleError("append", "Stored triage decision is corrupt", cause)
        )
  const fork =
    row.fork_json === null
      ? null
      : yield* decodeJsonWith(StoredForkSchema, row.fork_json, (cause) =>
          lifecycleError("append", "Stored fork origin is corrupt", cause)
        )
  return yield* Schema.decodeUnknownEffect(ListedSessionSchema)({
    presentation: presentations.get(sessionId),
    session_id: row.session_id,
    public_ref: row.public_ref,
    started_at: row.started_at,
    last_activity: row.last_activity,
    last_accessed_at: row.last_accessed_at,
    has_unread: row.has_unread !== 0,
    name: row.name,
    message_count: row.message_count,
    space_id: row.space_id,
    chat_model: row.chat_model,
    session_type: row.session_type ?? "chat",
    origin_automation_id: row.origin_automation_id,
    parent_session_id: row.parent_session_id,
    parent_run_id: row.parent_run_id,
    parent_tool_call_id: row.parent_tool_call_id,
    parent_message_id: row.parent_message_id,
    active_run_id: isActive ? row.run_id : null,
    latest_run_id: row.run_id,
    active_turn_id: isActive ? row.run_turn_id : null,
    run_status: row.run_status,
    checkpoint_seq: row.checkpoint_seq,
    latest_event_seq: row.latest_event_seq,
    is_active: isActive,
    pending_approvals_count: row.pending_approvals_count,
    pending_connections_count: row.pending_connections_count,
    run_error_code: row.run_error_code,
    run_stop_reason: row.run_stop_reason,
    triage:
      freshTriage(triage, { messageCount: row.message_count, lastActivity: row.last_activity }) ??
      null,
    fork,
    thread_source:
      row.thread_source_id === null
        ? null
        : { session_id: row.thread_source_id, session_ref: row.thread_source_ref },
    origin: row.origin
  }).pipe(
    Effect.mapError((cause) =>
      lifecycleError("append", "Stored Session lifecycle snapshot is corrupt", cause)
    )
  )
})

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

const loadTaskWork = Effect.fn("SessionLifecycleEvents.loadTaskWork")(function* (
  sql: SqlClient.SqlClient,
  target:
    | { readonly kind: "session"; readonly id: string }
    | {
        readonly kind: "item"
        readonly id: string
      }
): Effect.fn.Return<TaskWorkChangedEvent | undefined, SessionLifecycleEventError> {
  const targetPredicate =
    target.kind === "session"
      ? sql`run.session_id = ${target.id}`
      : sql`task.item_id = ${target.id}`
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
    space_id: row.space_id,
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
  if (row.task_status === "done") return "finished"
  if (row.task_status !== "open" || row.run_status === "cancelled") return "stopped"
  return row.run_status === "completed" ? "finished" : "failed"
}

const LifecycleRecordSchema = Schema.Union([AutomationEventSchema, InternalLifecycleEventSchema])

const decodeRecord = Effect.fn("SessionLifecycleEvents.decodeRecord")(function* (
  record: JournalRecord
) {
  const event = yield* Schema.decodeUnknownEffect(LifecycleRecordSchema)(record.data).pipe(
    Effect.mapError((cause) => lifecycleError("follow", "Stored global event is corrupt", cause))
  )
  if (event.type !== record.type) {
    return yield* lifecycleError("follow", "Stored global event type does not match its payload")
  }
  return event
})

const encodeLifecycleEvent = Schema.encodeEffect(Schema.toCodecJson(LifecycleRecordSchema))

const journalEvent = (
  event: AutomationEvent | InternalLifecycleEvent,
  options: { readonly live?: true } = {}
) =>
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

interface FeedEventMessages {
  readonly invalid: string
  readonly failed: string
}

type FeedEventSpecs = {
  readonly [Type in LifecycleFeedEvent["type"]]: FeedEventMessages & {
    readonly schema: Schema.Decoder<Extract<LifecycleFeedEvent, { readonly type: Type }>>
    /** Announced to the followers connected now and never stored: a status that
     * is stale once the run ends. Every other type is stored and replays. */
    readonly live?: true
  }
}

const automationMessages: FeedEventMessages = {
  invalid: "Invalid Automation event",
  failed: "Could not append the Automation event"
}
const taskAuthorityMessages: FeedEventMessages = {
  invalid: "Invalid Task authority event",
  failed: "Could not append the Task authority event"
}
const workMessages: FeedEventMessages = {
  invalid: "Invalid Work event",
  failed: "Could not append the Work event"
}

const runMessages: FeedEventMessages = {
  invalid: "Invalid run event",
  failed: "Could not append the run event"
}

const feedEventSpecs: FeedEventSpecs = {
  automation_progress: {
    schema: AutomationProgressEventSchema,
    ...automationMessages,
    live: true
  },
  automation_finished: { schema: AutomationFinishedEventSchema, ...automationMessages },
  record_told: { schema: RecordToldEventSchema, ...automationMessages },
  task_proposal_changed: { schema: TaskProposalChangedEventSchema, ...taskAuthorityMessages },
  focus_choice_changed: { schema: FocusChoiceChangedEventSchema, ...taskAuthorityMessages },
  work_changed: { schema: WorkChangedEventSchema, ...workMessages },
  question_changed: { schema: QuestionChangedEventSchema, ...workMessages },
  task_visibility_changed: { schema: TaskVisibilityChangedEventSchema, ...workMessages },
  chat_input_committed: {
    schema: ChatInputCommittedEventSchema,
    invalid: "Invalid personal Chat input",
    failed: "Could not append personal Chat input"
  },
  navigation_requested: {
    schema: NavigationRequestedEventSchema,
    invalid: "Invalid navigation request",
    failed: "Could not append the navigation request"
  },
  mcp_server_changed: {
    schema: McpServerChangedEventSchema,
    invalid: "Invalid connection change",
    failed: "Could not append the connection change"
  },
  entity_changed: {
    schema: EntityChangedEventSchema,
    invalid: "Invalid change",
    failed: "Could not append the change"
  },
  run_settled: { schema: RunSettledEventSchema, ...runMessages },
  run_fenced: { schema: RunFencedEventSchema, ...runMessages },
  approval_waiting: {
    schema: ApprovalWaitingEventSchema,
    invalid: "Invalid waiting approval",
    failed: "Could not append the waiting approval"
  },
  decision_route_changed: {
    schema: DecisionRouteChangedEventSchema,
    invalid: "Invalid decision route change",
    failed: "Could not append the decision route change"
  },
  automation_queued: {
    schema: AutomationQueuedEventSchema,
    invalid: "Invalid queued Automation work",
    failed: "Could not append the queued Automation work"
  },
  automation_changed: {
    schema: AutomationChangedEventSchema,
    invalid: "Invalid Automation change",
    failed: "Could not append the Automation change"
  },
  task_history_added: {
    schema: TaskHistoryAddedEventSchema,
    invalid: "Invalid Task history row",
    failed: "Could not append the Task history row"
  },
  capture_arrived: {
    schema: CaptureArrivedEventSchema,
    invalid: "Invalid capture",
    failed: "Could not append the capture"
  },
  limit_crossed: {
    schema: LimitCrossedEventSchema,
    invalid: "Invalid plan limit crossing",
    failed: "Could not append the plan limit crossing"
  }
}

const taskWorkItemId = (event: LifecycleFeedEvent): string | null => {
  switch (event.type) {
    case "work_changed":
    case "question_changed":
    case "task_visibility_changed":
      return event.item_id
    case "automation_progress":
    case "automation_finished":
    case "record_told":
    case "task_proposal_changed":
    case "focus_choice_changed":
    case "chat_input_committed":
    case "navigation_requested":
    case "mcp_server_changed":
    case "entity_changed":
    case "run_settled":
    case "run_fenced":
    case "limit_crossed":
    case "approval_waiting":
    case "decision_route_changed":
    case "capture_arrived":
    case "automation_queued":
    case "automation_changed":
    case "task_history_added":
      return null
  }
}

const SNAPSHOT_DELETE_BATCH = 500

const SNAPSHOT_EVENT_TYPES = "('session_created', 'session_activity')"

const snapshotSessionOf = (sql: SqlClient.SqlClient, table: string) =>
  sql.literal(`json_extract(${table}.data_json, '$.session.session_id')`)

interface SessionHistoryBoundary {
  readonly sessionId: string
  readonly retainedSequence: number
}

interface SnapshotScanRow {
  readonly sequence: number
  readonly session_id: string | null
}

const foldSnapshotPage = (
  latest: Map<string, number>,
  superseded: Array<number>,
  page: ReadonlyArray<SnapshotScanRow>,
  readThrough: number
): void => {
  for (const row of page) {
    if (row.session_id === null) continue
    const previous = latest.get(row.session_id)
    if (previous !== undefined && previous <= readThrough) superseded.push(previous)
    latest.set(row.session_id, row.sequence)
  }
}

export const makeSessionLifecycleEvents = ({
  writer,
  journal,
  chatEvents
}: Pick<PersistenceDeps, "writer" | "chatEvents"> & {
  readonly journal: JournalRuntime
}): SessionLifecycleEvents["Service"] => {
  const sql = writer.sql
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
    const session = yield* loadSessionSnapshot(sql, valid.sessionId)
    const lifecycleEvent = yield* journalEvent({ type: valid.type, session })
    const taskWork =
      valid.type === "session_activity"
        ? yield* loadTaskWork(sql, { kind: "session", id: valid.sessionId })
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

  const decodeEvent = Effect.fn("SessionLifecycleEvents.decodeEvent")(function* (
    event: LifecycleFeedEvent
  ): Effect.fn.Return<LifecycleFeedEvent, SessionLifecycleEventError> {
    const spec = feedEventSpecs[event.type]
    return yield* Schema.decodeUnknownEffect(spec.schema)(event).pipe(
      Effect.mapError((cause) => lifecycleError("append", spec.invalid, cause))
    )
  })

  const appendValidEventInTransaction = Effect.fn(
    "SessionLifecycleEvents.appendValidEventInTransaction"
  )(function* (valid: LifecycleFeedEvent) {
    // A live-only event has no task work beside it, so no stored record follows it.
    const feedEvent = yield* journalEvent(valid, feedEventSpecs[valid.type])
    const itemId = taskWorkItemId(valid)
    const taskWork =
      itemId === null ? undefined : yield* loadTaskWork(sql, { kind: "item", id: itemId })
    return yield* appendJournalInTransaction(
      sql,
      SESSION_LIFECYCLE_STREAM_ID,
      taskWork === undefined ? [feedEvent] : [feedEvent, yield* journalEvent(taskWork)]
    ).pipe(
      Effect.mapError((cause) =>
        lifecycleError("append", feedEventSpecs[valid.type].failed, cause)
      ),
      Effect.tap(afterCommit)
    )
  })

  const appendEventInTransaction = Effect.fn("SessionLifecycleEvents.appendEventInTransaction")(
    function* (event: LifecycleFeedEvent) {
      return yield* appendValidEventInTransaction(yield* decodeEvent(event))
    }
  )

  const appendEvent = Effect.fn("SessionLifecycleEvents.appendEvent")(function* (
    event: StandaloneFeedEvent
  ) {
    const valid = yield* decodeEvent(event)
    return yield* writer
      .transact(appendValidEventInTransaction(valid))
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionLifecycleEventError
            ? cause
            : lifecycleError("append", feedEventSpecs[event.type].failed, cause)
        )
      )
  })

  const pruneSessionHistory = Effect.fn("SessionLifecycleEvents.pruneSessionHistory")(
    function* (entries: ReadonlyArray<SessionHistoryBoundary>) {
      const valid = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            sessionId: Schema.NonEmptyString,
            retainedSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
          })
        )
      )(entries).pipe(
        Effect.mapError((cause) =>
          lifecycleError("prune", "Invalid Session lifecycle retention boundary", cause)
        )
      )
      if (valid.length === 0) return 0
      const boundary = new Map<string, number>()
      for (const entry of valid) boundary.set(entry.sessionId, entry.retainedSequence)
      const bounds = yield* writer.run(
        sql<{ readonly first: number | null; readonly head: number | null }>`
          SELECT
            (SELECT MIN(sequence) FROM ${journalRecordsSql(sql)}
             WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID}) AS first,
            ${journalHeadSequenceSql(sql, SESSION_LIFECYCLE_STREAM_ID)} AS head
        `
      )
      const first = bounds[0]?.first ?? null
      const head = bounds[0]?.head ?? null
      if (first === null || head === null) return 0
      const types = sql.literal(SNAPSHOT_EVENT_TYPES)
      const sequences = new Map<string, Array<number>>()
      yield* scanJournalWindows<SnapshotScanRow, never>({
        sql,
        read: writer.run,
        streamId: SESSION_LIFECYCLE_STREAM_ID,
        afterSequence: first - 1,
        throughSequence: head,
        columns: sql`sequence, ${snapshotSessionOf(sql, "journal_records")} AS session_id`,
        where: sql`event_type IN ${types}
          AND ${snapshotSessionOf(sql, "journal_records")} IN ${sql.in([...boundary.keys()])}`,
        onPage: (page) =>
          Effect.sync(() => {
            for (const row of page) {
              if (row.session_id === null) continue
              const list = sequences.get(row.session_id)
              if (list === undefined) sequences.set(row.session_id, [row.sequence])
              else list.push(row.sequence)
            }
          })
      })
      const doomed: Array<number> = []
      for (const [sessionId, list] of sequences) {
        const newest = list[list.length - 1]
        const retained = boundary.get(sessionId)
        if (newest === undefined || retained === undefined) continue
        const below = Math.min(newest, retained)
        for (const sequence of list) if (sequence < below) doomed.push(sequence)
      }
      return yield* deleteJournalSequences({
        writer,
        streamId: SESSION_LIFECYCLE_STREAM_ID,
        beforeSequence: head + 1,
        sequences: doomed,
        batchSize: SNAPSHOT_DELETE_BATCH,
        where: sql`event_type IN ${types}`
      })
    },
    Effect.mapError((cause) =>
      cause instanceof SessionLifecycleEventError
        ? cause
        : lifecycleError("prune", "Could not prune prior Session lifecycle snapshots", cause)
    )
  )

  const pruneSupersededSnapshots = Effect.fn("SessionLifecycleEvents.pruneSupersededSnapshots")(
    function* () {
      const cursor = yield* writer.run(
        sql<{ readonly after_sequence: number }>`
          SELECT after_sequence FROM automation_trigger_cursor
          WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID}
        `
      )
      const readThrough = cursor[0]?.after_sequence
      if (readThrough === undefined) return 0
      const types = sql.literal(SNAPSHOT_EVENT_TYPES)
      const latest = new Map<string, number>()
      const superseded: Array<number> = []
      const bounds = yield* writer.run(
        sql<{ readonly first: number | null; readonly head: number | null }>`
          SELECT
            (SELECT MIN(sequence) FROM ${journalRecordsSql(sql)}
             WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID}) AS first,
            ${journalHeadSequenceSql(sql, SESSION_LIFECYCLE_STREAM_ID)} AS head
        `
      )
      const first = bounds[0]?.first ?? null
      const head = bounds[0]?.head ?? null
      if (first === null || head === null) return 0
      yield* scanJournalWindows<SnapshotScanRow, never>({
        sql,
        read: writer.run,
        streamId: SESSION_LIFECYCLE_STREAM_ID,
        afterSequence: first - 1,
        throughSequence: head,
        columns: sql`sequence, ${snapshotSessionOf(sql, "journal_records")} AS session_id`,
        where: sql`event_type IN ${types}`,
        onPage: (page) => Effect.sync(() => foldSnapshotPage(latest, superseded, page, readThrough))
      })
      return yield* deleteJournalSequences({
        writer,
        streamId: SESSION_LIFECYCLE_STREAM_ID,
        beforeSequence: readThrough + 1,
        sequences: superseded,
        batchSize: SNAPSHOT_DELETE_BATCH,
        where: sql`event_type IN ${types}`
      })
    },
    Effect.mapError((cause) =>
      cause instanceof SessionLifecycleEventError
        ? cause
        : lifecycleError("prune", "Could not prune superseded Session snapshots", cause)
    )
  )

  const open = Effect.fn("SessionLifecycleEvents.open")(function* (
    afterSequence?: number
  ): Effect.fn.Return<OpenSessionLifecycleEvents, SessionLifecycleEventError, Scope.Scope> {
    const opened = yield* journal
      .openFollow({
        streamId: SESSION_LIFECYCLE_STREAM_ID,
        ...(afterSequence === undefined ? { startAt: "latest" as const } : { afterSequence })
      })
      .pipe(
        Effect.mapError((cause) =>
          lifecycleError("follow", "Could not open the Session lifecycle stream", cause)
        )
      )
    const stream = opened.stream.pipe(
      Stream.mapEffect(
        (delivery): Effect.Effect<SessionLifecycleDelivery, SessionLifecycleEventError> => {
          if (delivery.kind === "overflow") {
            return Effect.fail(
              lifecycleError("follow", "Session lifecycle follower buffer overflowed")
            )
          }
          return delivery.kind === "reset"
            ? Effect.succeed({ kind: "reset", reason: delivery.reason, cursor: delivery.cursor })
            : decodeRecord(delivery.record).pipe(
                Effect.map((event): SessionLifecycleDelivery => ({
                  kind: "record",
                  sequence: delivery.record.sequence,
                  createdAtMs: DateTime.toEpochMillis(
                    DateTime.makeUnsafe(delivery.record.createdAt)
                  ),
                  event: withCurrentSessionActivity({
                    event,
                    currentActivity: chatEvents.currentActivity
                  }),
                  replayed: delivery.replayed
                }))
              )
        }
      ),
      Stream.mapError((cause) =>
        cause instanceof SessionLifecycleEventError
          ? cause
          : lifecycleError("follow", "Could not follow Session lifecycle events", cause)
      )
    )
    return { initialSequence: opened.initialSequence, stream }
  })

  return SessionLifecycleEvents.of({
    appendInTransaction,
    appendBlockingWorkInTransaction,
    appendEventInTransaction,
    appendEvent,
    pruneSessionHistory,
    pruneSupersededSnapshots,
    open
  })
}
