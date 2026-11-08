import { foldSpace } from "@arden-hq/std/text"
import { outcomeSql } from "./automation-run-outcome.js"
import { countsAsRun } from "./automation-skip-record.js"
import type { SpaceJobPromptContext, SpaceReviewSnapshot } from "../automations/job-prompt.js"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { AutomationTriggerContext } from "@arden-hq/protocol/automations"
import type { SessionLifecycleEventError, SessionLifecycleEvents } from "../sessions/events.js"
import type { UnitOfWork } from "../unit-of-work.js"
import { enqueue, freshRow, type QueueWriter } from "./automation-enqueue.js"
import type { JsonColumnError } from "./json.js"

import { spaceJobId, taskJobId } from "../space-job-id.js"
import { hasPendingTaskApproval, hasPendingTaskQuestion } from "./task-question-state.js"
import { haltAutomation, type AutomationHalt } from "./automation-halt.js"
import { resumeAutomation } from "./automation-resume.js"
import { nextId } from "./deps.js"
import { insertSession } from "./session-insert.js"
import { readJobSpace, readJobTask, type SpaceRow } from "./space-job-rows.js"
import { readSpaceJobContext, readSpaceReviewContext } from "./space-job-context.js"
import { endExternalWaitAtCheck, failTaskItem, keepTaskMoving } from "./task-next-move.js"
import { iso } from "../../runtime/clock.js"
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
  readonly queueSpaceWake: (spaceId: string, now: string) => SpaceJobWrite<void>
  readonly retryReview: (automationId: string, now: string) => SpaceJobWrite<void>
  readonly holdReview: (automationId: string, now: string, until: string) => SpaceJobWrite<void>
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
  readonly queueTaskWake: (itemId: string, now: string, fromPerson?: boolean) => SpaceJobWrite<void>
  readonly stopTask: (itemId: string, settlingRunId?: string) => SpaceJobWrite<void>
  readonly context: (
    automationId: string
  ) => Effect.Effect<SpaceJobPromptContext | undefined, SqlError>
  readonly spaceReviewContext: (
    spaceId: string
  ) => Effect.Effect<SpaceReviewSnapshot | undefined, SqlError>
  readonly keepMoving: (automationId: string, chatRunId: string, now: string) => SpaceJobWrite<void>
  readonly failTask: (
    automationId: string,
    error: string | null,
    now: string,
    chatRunId: string | null
  ) => SpaceJobWrite<void>
}

const internalRef = (automationId: string): string => {
  const digest = sha256Hex(automationId).slice(0, 12)
  return `internal-job~${digest}`
}

const jobEnabled = (space: SpaceRow): boolean =>
  space.inference_enabled === 1 && space.page_path !== null && space.archived_at === null

const line = (value: string | null): string => foldSpace(value ?? "") || "none"

const appLink = (label: string, target: string): string =>
  `[${line(label).replace(/[\\[\]]/g, "\\$&")}](${target})`

export const makeSpaceJobSql = (
  sql: SqlClient.SqlClient,
  sessionEvents: SessionLifecycleEvents["Service"]
): SpaceJobSql => {
  const writer: QueueWriter = { sql, sessionEvents }
  const halt = Effect.fn("SpaceJobSql.halt")(function* (
    automationId: string,
    reason: AutomationHalt,
    settlingRunId?: string
  ) {
    const needsHalt =
      reason === "hold"
        ? sql`job.enabled = 1 OR job.next_run_at IS NOT NULL`
        : sql`job.enabled = 1 OR job.next_run_at IS NOT NULL OR job.running_since IS NOT NULL
          OR EXISTS (SELECT 1 FROM automation_event_queue AS queue WHERE queue.task_id = job.task_id)
          OR job.task_id IN (${automationRecoveryAuthority(sql)})`
    const pending = yield* sql`SELECT 1 FROM scheduled_tasks AS job
      WHERE job.task_id = ${automationId} AND (${needsHalt}) LIMIT 1`
    if (pending.length === 0) return
    yield* haltAutomation({ sql, sessionEvents, automationId, halt: reason, settlingRunId })
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
    if (existing[0] !== undefined) {
      yield* sql`UPDATE sessions SET name = ${name} WHERE session_id = ${existing[0].session_id} AND name IS NOT ${name}`
      return existing[0].session_id
    }

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

  const upsertJob = Effect.fn("SpaceJobSql.upsertJob")(function* (input: {
    readonly automationId: string
    readonly spaceId: string | null
    readonly name: string
    readonly prompt: string
    readonly enabled: boolean
    readonly inference?: boolean
    readonly ownerTaskId?: string
    readonly now: string
  }) {
    const sessionId = yield* ensureSession(input.automationId, input.spaceId, input.name, input.now)
    const before = yield* sql<{ readonly enabled: number }>`
      SELECT enabled FROM scheduled_tasks WHERE task_id = ${input.automationId}`
    const autoApprove = input.spaceId === null ? 0 : 1
    yield* sql`
      INSERT INTO scheduled_tasks (
        task_id, automation_ref, name, description, prompt, context_mode, triggers, trigger_last_id, enabled,
        created_at, auto_approve, builtin, thread_id,
        tool_scope, triggers_source, next_run_at, purpose, owner_space_id, owner_task_id
      ) VALUES (
        ${input.automationId}, ${internalRef(input.automationId)}, ${input.name},
        'Internal Space execution', ${input.prompt}, 'fresh', ${input.inference ? '[{"type":"event","event_type":"wiki.changed","id":"t1"}]' : "[]"}, ${input.inference ? 1 : 0}, ${input.enabled ? 1 : 0},
        ${input.now}, ${autoApprove}, 1, ${sessionId},
        'space', 'space_runtime', NULL,
        ${input.ownerTaskId === undefined ? "space_review" : "task_execution"}, ${input.spaceId}, ${input.ownerTaskId ?? null}
      )
      ON CONFLICT(task_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        prompt = excluded.prompt,
        context_mode = excluded.context_mode,
        triggers = excluded.triggers,
        trigger_last_id = MAX(scheduled_tasks.trigger_last_id, excluded.trigger_last_id),
        next_run_at = NULL,
        thread_id = COALESCE(scheduled_tasks.thread_id, excluded.thread_id),
        tool_scope = excluded.tool_scope,
        triggers_source = excluded.triggers_source,
        auto_approve = excluded.auto_approve,
        owner_space_id = excluded.owner_space_id
      WHERE scheduled_tasks.name IS NOT excluded.name
        OR scheduled_tasks.description IS NOT excluded.description
        OR scheduled_tasks.prompt IS NOT excluded.prompt
        OR scheduled_tasks.context_mode IS NOT excluded.context_mode
        OR scheduled_tasks.triggers IS NOT excluded.triggers
        OR scheduled_tasks.trigger_last_id < excluded.trigger_last_id
        OR scheduled_tasks.next_run_at IS NOT NULL
        OR scheduled_tasks.thread_id IS NULL
        OR scheduled_tasks.tool_scope IS NOT excluded.tool_scope
        OR scheduled_tasks.triggers_source IS NOT excluded.triggers_source
        OR scheduled_tasks.auto_approve IS NOT excluded.auto_approve
        OR scheduled_tasks.owner_space_id IS NOT excluded.owner_space_id
    `
    if (!input.enabled && before[0]?.enabled !== 0) yield* halt(input.automationId, "hold")
    if (input.enabled && before[0]?.enabled === 0)
      yield* resumeAutomation({ sql, automationId: input.automationId, nextRunAt: null })
    return {
      automationId: input.automationId,
      enabled: input.enabled,
      purpose: input.ownerTaskId === undefined ? "space_review" : "task_execution"
    } satisfies JobState
  })

  const syncTask = Effect.fn("SpaceJobSql.syncTask")(function* (itemId: string, now: string) {
    const task = yield* readJobTask(sql, itemId)
    const id = taskJobId(itemId)
    if (task === null || !taskIsLive(task) || task.space_archived_at !== null) {
      yield* halt(id, "stop")
      return null
    }
    return yield* upsertJob({
      automationId: id,
      ownerTaskId: itemId,
      spaceId: task.space_id,
      name: task.text,
      prompt: `Continue ${appLink(task.text, `arden:task/${encodeURIComponent(task.item_id)}`)}.`,
      enabled: taskStands(task),
      now
    })
  })

  const syncSpaceReview = Effect.fn("SpaceJobSql.syncSpaceReview")(function* (
    spaceId: string,
    now: string
  ) {
    const current = yield* readJobSpace(sql, spaceId)
    if (current === null || current.inference_enabled !== 1 || current.archived_at !== null) {
      yield* halt(
        spaceJobId(spaceId),
        current === null || current.archived_at !== null ? "stop" : "hold"
      )
      return null
    }
    return yield* upsertJob({
      automationId: spaceJobId(spaceId),
      spaceId,
      name: `${current.name} worker`,
      prompt: `Review ${appLink(current.name, `arden:space/${encodeURIComponent(current.space_id)}`)}.`,
      enabled: jobEnabled(current),
      inference: current.inference_enabled === 1,
      now
    })
  })

  const syncSpace = Effect.fn("SpaceJobSql.syncSpace")(function* (spaceId: string, now: string) {
    const current = yield* readJobSpace(sql, spaceId)
    const workable = current !== null && current.archived_at === null
    const ended = current === null || current.archived_at !== null
    if (workable) {
      const waiting = yield* sql<{ readonly task_id: string }>`
        SELECT task_id FROM scheduled_tasks
        WHERE enabled = 0 AND purpose = 'task_execution'
          AND owner_task_id IN (
            SELECT candidate.item_id
            FROM space_tasks AS candidate
            WHERE candidate.space_id = ${spaceId}
              AND ${taskStandsSql(sql, "candidate")}
          )
      `
      for (const job of waiting)
        yield* resumeAutomation({ sql, automationId: job.task_id, nextRunAt: null })
    } else {
      const jobs = yield* sql<{ readonly task_id: string }>`
        SELECT task_id FROM scheduled_tasks
        WHERE purpose = 'task_execution'
          AND owner_task_id IN (SELECT item_id FROM space_tasks WHERE space_id = ${spaceId})`
      for (const job of jobs) yield* halt(job.task_id, ended ? "stop" : "hold")
    }
    return yield* syncSpaceReview(spaceId, now)
  })

  const queue = Effect.fn("SpaceJobSql.queue")(function* (
    state: JobState,
    trigger: AutomationTriggerContext,
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
        trigger_context_snapshot: trigger,
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

  const queueSpaceWake = Effect.fn("SpaceJobSql.queueSpaceWake")(function* (
    spaceId: string,
    now: string
  ) {
    const state = yield* syncSpace(spaceId, now)
    if (state === null) return
    yield* queue(state, {
      source: "event",
      queued_at: now,
      event_type: "space.wake",
      event_key: spaceId,
      produced_by: null,
      context: { space_id: spaceId }
    })
  })

  const retryReview = Effect.fn("SpaceJobSql.retryReview")(function* (
    automationId: string,
    now: string
  ) {
    const attempts = yield* sql<{
      readonly failed: number
      readonly restart_cut: number
      readonly space_id: string | null
    }>`
      SELECT ${outcomeSql(sql, sql`attempt`)} = 'failed' AS failed,
        COALESCE(${restartCutRunSql("chat")}, 0) AS restart_cut,
        job.owner_space_id AS space_id
      FROM automation_runs AS attempt JOIN scheduled_tasks AS job ON job.task_id = attempt.task_id
      LEFT JOIN chat_runs AS chat ON chat.run_id = attempt.chat_run_id
      WHERE attempt.task_id = ${automationId} AND job.purpose = 'space_review'
        AND attempt.status <> 'running' AND ${countsAsRun(sql, sql`attempt`)}
      ORDER BY attempt.id DESC LIMIT ${SPACE_REVIEW_LADDER_MS.length + 1}`
    const spaceId = attempts[0]?.space_id
    const recent = attempts.filter((row) => row.restart_cut !== 1)
    const streak = recent.findIndex((row) => row.failed !== 1)
    const delay = ladderStepMs(SPACE_REVIEW_LADDER_MS, streak === -1 ? recent.length : streak)
    if (spaceId == null || delay === undefined) return
    yield* queueReviewFollowUp({
      automationId,
      spaceId,
      now,
      eventType: "space.review_retry",
      at: iso(Date.parse(now) + delay),
      waiting: "delay"
    })
  })

  const holdReview = Effect.fn("SpaceJobSql.holdReview")(function* (
    automationId: string,
    now: string,
    until: string
  ) {
    const jobs = yield* sql<{ readonly space_id: string | null }>`
      SELECT owner_space_id AS space_id FROM scheduled_tasks
      WHERE task_id = ${automationId} AND purpose = 'space_review'`
    const spaceId = jobs[0]?.space_id
    if (spaceId == null) return
    yield* queueReviewFollowUp({
      automationId,
      spaceId,
      now,
      eventType: "space.review_held",
      at: until,
      waiting: "keep"
    })
  })

  const queueReviewFollowUp = Effect.fn("SpaceJobSql.queueReviewFollowUp")(function* (input: {
    readonly automationId: string
    readonly spaceId: string
    readonly now: string
    readonly eventType: "space.review_retry" | "space.review_held"
    readonly at: string
    readonly waiting: "delay" | "keep"
  }) {
    const state = yield* syncSpace(input.spaceId, input.now)
    if (state === null || !state.enabled) return
    if (input.waiting === "keep") {
      const waiting = yield* sql`SELECT 1 FROM automation_event_queue
        WHERE task_id = ${input.automationId} AND ${freshRow(sql)} AND source = 'wake'
        LIMIT 1`
      if (waiting.length > 0) return
    }
    yield* queue(
      state,
      {
        source: "event",
        queued_at: input.now,
        event_type: input.eventType,
        event_key: input.automationId,
        produced_by: null,
        context: { space_id: input.spaceId }
      },
      { dueAt: Date.parse(input.at) }
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
        AND json_extract(request.message_json, '$.is_meta') IS NOT 1
        AND json_extract(run.metadata_json, '$.automation') IS NULL
      ORDER BY run.started_at DESC, run.run_id DESC, ancestors.depth DESC LIMIT 1`
    const row = rows[0]
    if (!row) return false
    const state = yield* syncSpace(row.space_id, now)
    if (!state?.enabled) return false
    return yield* queue(
      state,
      {
        source: "event",
        queued_at: now,
        event_type: "chat.completed",
        event_key: row.run_id,
        produced_by: null,
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
        AND run.status = 'completed' AND json_extract(request.message_json, '$.is_meta') IS NOT 1
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
      {
        source: "event",
        queued_at: now,
        event_type: "chat.completed",
        event_key: run.run_id,
        produced_by: null,
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
      {
        source: "event",
        queued_at: now,
        event_type: "item.routed",
        event_key: spaceId,
        produced_by: null,
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
    fromPerson = false
  ) {
    const task = yield* readJobTask(sql, itemId)
    if (task !== null && !taskStands(task)) yield* halt(taskJobId(itemId), "hold")
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
      {
        source: "event",
        queued_at: now,
        event_type: "task.wake",
        event_key: task.item_id,
        produced_by: null,
        context: { space_id: task.space_id, item_id: task.item_id }
      },
      fromPerson ? { personChangeAt: now } : {}
    )
  })

  const stopTask = Effect.fn("SpaceJobSql.stopTask")(function* (
    itemId: string,
    settlingRunId?: string
  ) {
    yield* halt(taskJobId(itemId), "stop", settlingRunId)
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
      yield* queue(state, {
        source: "event",
        queued_at: now,
        event_type: "task.due",
        event_key: row.item_id,
        produced_by: null,
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
    halt,
    queueTaskWake,
    materializeDue
  })

  const jobTaskItem = Effect.fn("SpaceJobSql.jobTaskItem")(function* (automationId: string) {
    const jobs = yield* sql<{
      readonly owner_task_id: string
    }>`SELECT owner_task_id FROM scheduled_tasks WHERE task_id = ${automationId} AND purpose = 'task_execution'`
    return jobs[0]?.owner_task_id
  })

  const failTask = Effect.fn("SpaceJobSql.failTask")(function* (
    automationId: string,
    error: string | null,
    now: string,
    chatRunId: string | null
  ) {
    const itemId = yield* jobTaskItem(automationId)
    if (itemId === undefined) return
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
    automationId: string,
    chatRunId: string,
    now: string
  ) {
    const itemId = yield* jobTaskItem(automationId)
    if (itemId === undefined) return
    yield* keepTaskMoving(writer, { itemId, chatRunId, now })
  })

  return {
    reconcile,
    materializeDue,
    syncSpace,
    queueSpaceWake,
    retryReview,
    holdReview,
    queueInferenceChat,
    linkChat,
    unlinkedSpaces,
    queueItemsRouted,
    queueTaskWake,
    stopTask,
    context: (automationId) => readSpaceJobContext(sql, automationId),
    spaceReviewContext: (spaceId) => readSpaceReviewContext(sql, spaceId),
    keepMoving,
    failTask
  }
}
