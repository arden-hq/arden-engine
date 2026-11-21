import { writtenByPersonSql } from "./person-written-sql.js"
import { outcomeSql } from "./automation-run-outcome.js"
import { countsAsRun } from "./automation-skip-record.js"
import type { SpaceReviewSnapshot } from "../automations/job-prompt.js"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { AutomationTriggerContext } from "@arden-hq/protocol/automations"
import type { SessionLifecycleEventError, SessionLifecycleEvents } from "../sessions/events.js"
import type { UnitOfWork } from "../unit-of-work.js"
import { enqueue, type QueueWriter } from "./automation-enqueue.js"
import type { JsonColumnError } from "./json.js"
import { attemptWakeDepth, readRunCause, taskWakeDepth } from "./run-cause.js"

import { spaceJobId, spaceOfJob, taskJobId } from "../space-job-id.js"
import { hasPendingTaskApproval, hasPendingTaskQuestion } from "./task-question-state.js"
import { haltWork } from "./automation-halt.js"
import { nextId } from "./deps.js"
import { insertSession } from "./session-insert.js"
import { readJobSpace, readJobTask } from "./space-job-rows.js"
import { recordReviewChat } from "./owner-chat.js"
import { readSpaceReviewContext } from "./space-job-context.js"
import { endExternalWaitAtCheck, failTaskItem, keepTaskMoving } from "./task-next-move.js"
import {
  automationRecoveryAuthority,
  makeSpaceJobRecovery,
  type SpaceJobRecoveryCursor
} from "./space-job-recovery.js"
import { taskIsLive, taskMayWake, taskMayWakeSql, taskStands, taskStandsSql } from "./task-wake.js"
import { restartCutRunSql } from "./status-sets.js"
import { SPACE_REVIEW_LADDER_MS, ladderStepMs } from "../automations/retry-ladders.js"
import { userChatSql } from "./chat-ownership.js"
import { delegatedLinkSql, sessionAncestors } from "./tree-walk.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { keyMessageJson } from "./chat-key-message.js"

type EventWake = Extract<AutomationTriggerContext, { readonly source: "event" }>

type WakeCause = Pick<EventWake, "produced_by" | "chain_depth">

const woken = (producedBy: string | null, chainDepth: number): WakeCause =>
  chainDepth === 0
    ? { produced_by: producedBy }
    : { produced_by: producedBy, chain_depth: chainDepth }

const NO_RUN = woken(null, 0)

export type TaskWaker =
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "owner" }
  | { readonly kind: "continuation" }

export const taskWaker = (runId: string | undefined): TaskWaker =>
  runId === undefined ? { kind: "owner" } : { kind: "run", runId }

interface JobState {
  readonly automationId: string
  readonly enabled: boolean
  readonly purpose: "space_review" | "task_execution"
}

type SpaceJobWrite<A> = Effect.Effect<
  A,
  SqlError | JsonColumnError | SessionLifecycleEventError,
  UnitOfWork
>

export interface SpaceJobSql {
  readonly reconcile: (
    now: string,
    cursor: SpaceJobRecoveryCursor | undefined
  ) => SpaceJobWrite<SpaceJobRecoveryCursor | undefined>
  readonly materializeDue: (now: string) => SpaceJobWrite<void>
  readonly syncSpace: (spaceId: string, now: string) => SpaceJobWrite<JobState | null>
  readonly queueOwnerSpaceChangeWake: (
    spaceId: string,
    now: string,
    runId: string | undefined
  ) => SpaceJobWrite<void>
  readonly queueTaskChangedByHand: (itemId: string, now: string) => SpaceJobWrite<boolean>
  readonly retryReview: (automationId: string, now: string) => SpaceJobWrite<void>
  readonly queueInferenceChat: (sessionId: string, now: string) => SpaceJobWrite<boolean>
  readonly linkChat: (
    spaceId: string,
    sessionId: string,
    throughSequence: number,
    now: string
  ) => SpaceJobWrite<boolean>
  readonly unlinkedSpaces: (
    sessionId: string,
    throughSequence: number,
    spaceIds: ReadonlyArray<string>
  ) => SpaceJobWrite<ReadonlyArray<string>>
  readonly queueItemsRouted: (spaceId: string, now: string) => SpaceJobWrite<void>
  readonly queueTaskWake: (
    itemId: string,
    now: string,
    by: TaskWaker,
    fromPerson?: boolean
  ) => SpaceJobWrite<void>
  readonly stopTask: (itemId: string, settlingRunId?: string) => SpaceJobWrite<void>
  readonly spaceReviewContext: (
    spaceId: string
  ) => Effect.Effect<SpaceReviewSnapshot | undefined, SqlError>
  readonly keepMoving: (itemId: string, chatRunId: string, now: string) => SpaceJobWrite<void>
  readonly failTask: (
    itemId: string,
    error: string | null,
    now: string,
    chatRunId: string | null
  ) => SpaceJobWrite<void>
}

export const internalRef = (automationId: string): string => {
  const digest = sha256Hex(automationId).slice(0, 12)
  return `internal-job~${digest}`
}

export const makeSpaceJobSql = (
  sql: SqlClient.SqlClient,
  sessionEvents: SessionLifecycleEvents["Service"]
): SpaceJobSql => {
  const writer: QueueWriter = { sql, sessionEvents }
  const wakeCause = Effect.fn("SpaceJobSql.wakeCause")(function* (runId: string | undefined) {
    if (runId === undefined) return NO_RUN
    const cause = yield* readRunCause(sql, runId)
    return woken(cause.produced_by, cause.chain_depth)
  })
  const taskWakeCause = Effect.fn("SpaceJobSql.taskWakeCause")(function* (
    itemId: string,
    by: TaskWaker
  ) {
    switch (by.kind) {
      case "run":
        return yield* wakeCause(by.runId)
      case "owner":
        return NO_RUN
      case "continuation": {
        const [task] = yield* sql<{ readonly chain_depth: number }>`
          SELECT ${taskWakeDepth(sql, sql`${itemId}`)} AS chain_depth`
        return woken(null, task?.chain_depth ?? 0)
      }
    }
  })
  const stopWork = Effect.fn("SpaceJobSql.stopWork")(function* (
    automationId: string,
    settlingRunId?: string
  ) {
    const pending = yield* sql`SELECT 1
      WHERE EXISTS (SELECT 1 FROM automation_event_queue AS queue WHERE queue.task_id = ${automationId})
        OR ${automationId} IN (${automationRecoveryAuthority(sql)})`
    if (pending.length === 0) return
    yield* haltWork({ sql, sessionEvents, automationId, halt: "stop", settlingRunId })
  })
  const ensureSession = Effect.fn("SpaceJobSql.ensureSession")(function* (
    automationId: string,
    spaceId: string | null,
    name: string,
    now: string
  ) {
    const existing = yield* sql<{ readonly session_id: string }>`
      SELECT session_id
      FROM sessions
      WHERE origin_automation_id = ${automationId}
        AND session_type = 'channel'
        AND archived_at IS NULL
      ORDER BY started_at, session_id
      LIMIT 1
    `
    if (existing[0] !== undefined) return existing[0].session_id

    const sessionId = yield* nextId
    yield* insertSession({
      sql,
      session: {
        type: "channel",
        sessionId,
        publicRef: internalRef(`${automationId}:${sessionId}`),
        startedAt: now,
        name,
        metadata: "{}",
        spaceId,
        chatModel: null,
        originAutomationId: automationId
      },
      lifecycle: { kind: "silent", reason: "worker_channel" }
    })
    return sessionId
  })

  const stopTask = (itemId: string, settlingRunId?: string) =>
    stopWork(taskJobId(itemId), settlingRunId)

  const syncTask = Effect.fn("SpaceJobSql.syncTask")(function* (itemId: string, now: string) {
    const task = yield* readJobTask(sql, itemId)
    const id = taskJobId(itemId)
    if (task === null || !taskIsLive(task) || task.space_archived_at !== null) {
      yield* stopTask(itemId)
      return null
    }
    yield* sql`UPDATE sessions SET name = ${task.text}
      WHERE origin_automation_id = ${id} AND session_type = 'channel' AND name IS NOT ${task.text}`
    yield* ensureSession(id, task.space_id, task.text, now)
    return {
      automationId: id,
      enabled: taskStands(task),
      purpose: "task_execution"
    } satisfies JobState
  })

  const syncSpaceReview = Effect.fn("SpaceJobSql.syncSpaceReview")(function* (
    spaceId: string,
    now: string
  ) {
    const automationId = spaceJobId(spaceId)
    const current = yield* readJobSpace(sql, spaceId)
    if (current === null || current.archived_at !== null) {
      yield* stopWork(automationId)
      return null
    }
    if (current.inference_enabled !== 1) return null
    const name = `${current.name} worker`
    const chats = yield* sql`SELECT 1 FROM space_review_chats WHERE space_id = ${spaceId}`
    if (chats.length === 0)
      yield* recordReviewChat(
        sql,
        spaceId,
        yield* ensureSession(automationId, spaceId, name, now),
        "keep"
      )
    return {
      automationId,
      enabled: current.review_may_run === 1,
      purpose: "space_review"
    } satisfies JobState
  })

  const syncSpace = Effect.fn("SpaceJobSql.syncSpace")(function* (spaceId: string, now: string) {
    const current = yield* readJobSpace(sql, spaceId)
    if (current === null || current.archived_at !== null) {
      const tasks = yield* sql<{ readonly item_id: string }>`
        SELECT item_id FROM space_tasks WHERE space_id = ${spaceId}`
      for (const task of tasks) yield* stopTask(task.item_id)
    }
    return yield* syncSpaceReview(spaceId, now)
  })

  const queue = Effect.fn("SpaceJobSql.queue")(function* (
    state: JobState,
    cause: WakeCause,
    wake: Omit<EventWake, "source" | "produced_by" | "chain_depth">,
    options: {
      readonly triggerContext?: string
      readonly personChangeAt?: string
      readonly dueAt?: number
      readonly once?: string
    } = {}
  ) {
    return yield* enqueue(writer, {
      automationId: state.automationId,
      source: "wake",
      key: state.automationId,
      context: {
        scheduled_for: null,
        automation_run_id: null,
        trigger_context_snapshot: { source: "event", ...wake, ...cause } satisfies EventWake,
        ...(options.triggerContext === undefined
          ? {}
          : { trigger_context: options.triggerContext }),
        ...(options.personChangeAt === undefined
          ? {}
          : { person_change_at: options.personChangeAt })
      },
      pending: "merge",
      ...(options.dueAt === undefined ? {} : { dueAt: options.dueAt }),
      ...(options.once === undefined ? {} : { once: options.once })
    })
  })

  /** Queues a review wake only when the review can run; touches no Task worker job. */
  const queueReviewWake = Effect.fn("SpaceJobSql.queueReviewWake")(function* (
    spaceId: string,
    now: string,
    cause: WakeCause
  ) {
    const space = yield* readJobSpace(sql, spaceId)
    if (space === null || space.review_may_run !== 1) return false
    const state = yield* syncSpaceReview(spaceId, now)
    if (state === null) return false
    return yield* queue(state, cause, {
      queued_at: now,
      event_type: "space.wake",
      event_key: spaceId,
      context: { space_id: spaceId }
    })
  })

  const queueOwnerSpaceChangeWake = Effect.fn("SpaceJobSql.queueOwnerSpaceChangeWake")(function* (
    spaceId: string,
    now: string,
    runId: string | undefined
  ) {
    yield* syncSpace(spaceId, now)
    yield* queueReviewWake(spaceId, now, yield* wakeCause(runId))
  })

  /** A change to a Task's reviewed fields made by hand, with no run behind it. */
  const queueTaskChangedByHand = Effect.fn("SpaceJobSql.queueTaskChangedByHand")(function* (
    itemId: string,
    now: string
  ) {
    const tasks = yield* sql<{ readonly space_id: string | null }>`
      SELECT space_id FROM space_tasks WHERE item_id = ${itemId}`
    const spaceId = tasks[0]?.space_id ?? undefined
    return spaceId === undefined ? false : yield* queueReviewWake(spaceId, now, NO_RUN)
  })

  const retryReview = Effect.fn("SpaceJobSql.retryReview")(function* (
    automationId: string,
    now: string
  ) {
    const spaceId = spaceOfJob(automationId)
    if (spaceId === undefined) return
    const attempts = yield* sql<{
      readonly failed: number
      readonly restart_cut: number
      readonly chain_depth: number
    }>`
      SELECT ${outcomeSql(sql, sql`attempt`)} = 'failed' AS failed,
        ${attemptWakeDepth(sql, "attempt")} AS chain_depth,
        COALESCE(${restartCutRunSql("chat")}, 0) AS restart_cut
      FROM automation_runs AS attempt
      LEFT JOIN chat_runs AS chat ON chat.run_id = attempt.chat_run_id
      WHERE attempt.task_id = ${automationId}
        AND attempt.status <> 'running' AND ${countsAsRun(sql, sql`attempt`)}
      ORDER BY attempt.id DESC LIMIT ${SPACE_REVIEW_LADDER_MS.length + 1}`
    const recent = attempts.filter((row) => row.restart_cut !== 1)
    const streak = recent.findIndex((row) => row.failed !== 1)
    const delay = ladderStepMs(SPACE_REVIEW_LADDER_MS, streak === -1 ? recent.length : streak)
    if (attempts.length === 0 || delay === undefined) return
    const state = yield* syncSpace(spaceId, now)
    if (state === null || !state.enabled) return
    yield* queue(
      state,
      woken(null, attempts[0]?.chain_depth ?? 0),
      {
        queued_at: now,
        event_type: "space.review_retry",
        event_key: automationId,
        context: { space_id: spaceId }
      },
      { dueAt: Date.parse(now) + delay }
    )
  })

  const queueInferenceChat = Effect.fn("SpaceJobSql.queueInferenceChat")(function* (
    sessionId: string,
    now: string
  ) {
    const rows = yield* sql<{
      readonly space_id: string
      readonly run_id: string
      readonly turn_id: string
      readonly public_ref: string
    }>`
      WITH RECURSIVE ${sessionAncestors(sql, {
        name: "ancestors",
        from: sql`SELECT session_id FROM sessions WHERE session_id = ${sessionId}`,
        where: delegatedLinkSql(sql),
        depth: { max: 64 }
      })}
      SELECT space.space_id, run.run_id, json_extract(run.metadata_json, '$.turn_id') AS turn_id, session.public_ref
      FROM ancestors JOIN sessions AS session ON session.session_id = ancestors.session_id
      JOIN spaces AS space ON space.space_id = session.space_id
      JOIN chat_runs AS run ON run.session_id = ${sessionId}
      LEFT JOIN chat_idempotency_keys AS request ON request.run_id = run.run_id AND request.client_id = run.client_id
      WHERE ${userChatSql("session")}
        AND session.archived_at IS NULL
        AND space.archived_at IS NULL AND json_extract(space.inference_policy, '$.enabled') = 1
        AND run.status = 'completed' AND json_extract(run.metadata_json, '$.turn_id') IS NOT NULL
        AND ${writtenByPersonSql(sql, keyMessageJson(sql, "request"))}
        AND json_extract(run.metadata_json, '$.automation') IS NULL
      ORDER BY run.started_at DESC, run.run_id DESC, ancestors.depth DESC LIMIT 1`
    const row = rows[0]
    if (!row) return false
    const state = yield* syncSpace(row.space_id, now)
    if (!state?.enabled) return false
    return yield* queue(
      state,
      yield* wakeCause(row.run_id),
      {
        queued_at: now,
        event_type: "chat.completed",
        event_key: row.run_id,
        context: {
          space_id: row.space_id,
          session_id: sessionId,
          run_id: row.run_id,
          turn_id: row.turn_id
        }
      },
      {
        triggerContext: `Review actual changed evidence in Chat ${JSON.stringify(row.public_ref)} and completed session ${JSON.stringify(sessionId)}, turn ${JSON.stringify(row.turn_id)}. Include delegated outcomes. Read the conversation and existing Tasks before inferring; the trigger itself is not evidence. If this turn only answers, rejects or acknowledges prior conversation, create nothing unless it states a new durable outcome.`,
        once: `chat:${row.run_id}`
      }
    )
  })

  const coveredRun = Effect.fn("SpaceJobSql.coveredRun")(function* (
    sessionId: string,
    throughSequence: number
  ) {
    const runs = yield* sql<{
      readonly run_id: string
      readonly turn_id: string
      readonly public_ref: string
      readonly space_id: string | null
    }>`
      SELECT run.run_id, json_extract(run.metadata_json, '$.turn_id') AS turn_id,
        session.public_ref, session.space_id
      FROM sessions AS session JOIN chat_runs AS run ON run.session_id = session.session_id
      JOIN chat_idempotency_keys AS request ON request.run_id = run.run_id AND request.client_id = run.client_id
      LEFT JOIN session_messages AS answer ON answer.session_id = run.session_id
        AND answer.message_id = run.assistant_message_id
      WHERE session.session_id = ${sessionId} AND ${userChatSql("session")} AND session.archived_at IS NULL
        AND run.status = 'completed' AND ${writtenByPersonSql(sql, keyMessageJson(sql, "request"))}
        AND json_extract(run.metadata_json, '$.automation') IS NULL
        AND json_extract(run.metadata_json, '$.turn_id') IS NOT NULL
        AND (answer.seq IS NULL OR answer.seq <= ${throughSequence})
      ORDER BY run.started_at DESC, run.run_id DESC LIMIT 1`
    return runs[0]
  })

  const unlinkedSpaces = Effect.fn("SpaceJobSql.unlinkedSpaces")(function* (
    sessionId: string,
    throughSequence: number,
    spaceIds: ReadonlyArray<string>
  ) {
    const run = yield* coveredRun(sessionId, throughSequence)
    if (run === undefined || spaceIds.length === 0) return []
    const linked = yield* sql<{ readonly space_id: string }>`SELECT space_id FROM space_chat_links
      WHERE session_id = ${sessionId} AND run_id = ${run.run_id} AND space_id IN ${sql.in(spaceIds)}`
    const done = new Set([
      ...linked.map((row) => row.space_id),
      ...(run.space_id ? [run.space_id] : [])
    ])
    return spaceIds.filter((spaceId) => !done.has(spaceId))
  })

  const linkChat = Effect.fn("SpaceJobSql.linkChat")(function* (
    spaceId: string,
    sessionId: string,
    throughSequence: number,
    now: string
  ) {
    const run = yield* coveredRun(sessionId, throughSequence)
    if (run === undefined || run.space_id === spaceId) return false
    const known = yield* sql`SELECT 1 FROM space_chat_links WHERE space_id = ${spaceId}
      AND session_id = ${sessionId} AND run_id = ${run.run_id}`
    if (known.length > 0) return false
    const state = yield* syncSpace(spaceId, now)
    if (!state?.enabled) return false
    yield* sql`INSERT INTO space_chat_links (space_id, session_id, run_id, linked_at)
      VALUES (${spaceId}, ${sessionId}, ${run.run_id}, ${now})
      ON CONFLICT(space_id, session_id) DO UPDATE SET run_id = excluded.run_id,
        linked_at = excluded.linked_at`
    return yield* queue(
      state,
      yield* wakeCause(run.run_id),
      {
        queued_at: now,
        event_type: "chat.completed",
        event_key: run.run_id,
        context: {
          space_id: spaceId,
          session_id: sessionId,
          run_id: run.run_id,
          turn_id: run.turn_id
        }
      },
      {
        triggerContext: `Chat ${JSON.stringify(run.public_ref)} is outside this Space and may have completed one of its open proposals. Read its turn ${JSON.stringify(run.turn_id)} and retire a proposal only if that turn, or another record, proves the outcome done; the trigger itself is not evidence.`,
        once: `chat:${run.run_id}`
      }
    )
  })

  const queueItemsRouted = Effect.fn("SpaceJobSql.queueItemsRouted")(function* (
    spaceId: string,
    now: string
  ) {
    const spaces = yield* sql<{ readonly space_id: string }>`
      SELECT space_id FROM spaces WHERE space_id = ${spaceId} AND archived_at IS NULL
        AND json_extract(inference_policy, '$.enabled') = 1`
    if (spaces.length === 0) return
    const state = yield* syncSpace(spaceId, now)
    if (!state?.enabled) return
    yield* queue(
      state,
      NO_RUN,
      {
        queued_at: now,
        event_type: "item.routed",
        event_key: spaceId,
        context: { space_id: spaceId }
      },
      {
        triggerContext:
          "New items from the user's connections were routed to this Space. They are listed under Routed connection items; the trigger itself is not evidence."
      }
    )
  })

  const queueTaskWake = Effect.fn("SpaceJobSql.queueTaskWake")(function* (
    itemId: string,
    now: string,
    by: TaskWaker,
    fromPerson = false
  ) {
    const task = yield* readJobTask(sql, itemId)
    if (
      task === null ||
      !taskMayWake(task) ||
      (!fromPerson && task.next_attempt_at !== null && task.next_attempt_at > now)
    )
      return
    const waiting = fromPerson
      ? hasPendingTaskApproval(sql, sql`${task.item_id}`)
      : hasPendingTaskQuestion(sql, sql`${task.item_id}`)
    const blocked = yield* sql<{ readonly present: number }>`SELECT ${waiting} AS present`
    if (blocked[0]?.present === 1) return
    const state = yield* syncTask(task.item_id, now)
    if (state === null) return
    yield* queue(
      state,
      yield* taskWakeCause(task.item_id, by),
      {
        queued_at: now,
        event_type: "task.wake",
        event_key: task.item_id,
        context: { space_id: task.space_id, item_id: task.item_id }
      },
      fromPerson ? { personChangeAt: now } : {}
    )
  })

  const materializeDue = Effect.fn("SpaceJobSql.materializeDue")(function* (now: string) {
    const waiting = yield* sql<{ readonly item_id: string }>`
      SELECT item.item_id FROM space_tasks AS item
      WHERE item.blocked = 1 AND item.waiting_on = 'external'
        AND ${taskStandsSql(sql, "item")}
        AND NOT ${hasPendingTaskQuestion(sql, sql`item.item_id`)}
        AND item.next_attempt_at IS NOT NULL
        AND item.next_attempt_at <= ${now}
      ORDER BY item.next_attempt_at, item.item_id
      LIMIT 100
    `
    for (const row of waiting) yield* endExternalWaitAtCheck(writer, row.item_id, now)
    const due = yield* sql<{ readonly item_id: string; readonly next_attempt_at: string }>`
      SELECT item.item_id, item.next_attempt_at
      FROM space_tasks AS item
      WHERE ${taskMayWakeSql(sql, "item")}
        AND NOT ${hasPendingTaskQuestion(sql, sql`item.item_id`)}
        AND item.next_attempt_at IS NOT NULL
        AND item.next_attempt_at <= ${now}
      ORDER BY item.next_attempt_at, item.item_id
      LIMIT 100
    `
    for (const row of due) {
      const state = yield* syncTask(row.item_id, now)
      if (state === null) continue
      yield* queue(state, yield* taskWakeCause(row.item_id, { kind: "continuation" }), {
        queued_at: now,
        event_type: "task.due",
        event_key: row.item_id,
        context: { item_id: row.item_id, scheduled_for: row.next_attempt_at }
      })
      yield* sql`
        UPDATE space_tasks SET next_attempt_at = NULL
        WHERE item_id = ${row.item_id}
      `
    }
  })

  const reconcile = makeSpaceJobRecovery({
    sql,
    syncSpace: syncSpaceReview,
    syncTask,
    stopWork,
    queueTaskWake,
    materializeDue
  })

  const failTask = Effect.fn("SpaceJobSql.failTask")(function* (
    itemId: string,
    error: string | null,
    now: string,
    chatRunId: string | null
  ) {
    const codes =
      chatRunId === null
        ? []
        : yield* sql<{ readonly error_code: string | null }>`
      SELECT error_code FROM chat_runs WHERE run_id = ${chatRunId}`
    yield* failTaskItem(writer, {
      itemId,
      error,
      errorCode: codes[0]?.error_code ?? null,
      chatRunId,
      now
    })
  })

  const keepMoving = Effect.fn("SpaceJobSql.keepMoving")(function* (
    itemId: string,
    chatRunId: string,
    now: string
  ) {
    yield* keepTaskMoving(writer, { itemId, chatRunId, now })
  })

  return {
    reconcile,
    materializeDue,
    syncSpace,
    queueOwnerSpaceChangeWake,
    queueTaskChangedByHand,
    retryReview,
    queueInferenceChat,
    linkChat,
    unlinkedSpaces,
    queueItemsRouted,
    queueTaskWake,
    stopTask,
    spaceReviewContext: (spaceId) => readSpaceReviewContext(sql, spaceId),
    keepMoving,
    failTask
  }
}
