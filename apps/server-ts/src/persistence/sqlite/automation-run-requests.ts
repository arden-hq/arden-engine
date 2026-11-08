import { recordBlockedAutomationInTransaction } from "./run-sidecar-mutations.js"
import { parseLease } from "./automation-lease.js"
import { appendSessionTurn, currentSessionTurnId } from "./turns.js"
import { hideFromActiveContext } from "./active-context.js"
import { transactWithActiveContext } from "./active-context-stage.js"
import { Clock, Effect, Schema } from "effect"
import { ChatRunErrorCodeSchema } from "@arden-hq/protocol/effect/chat"
import { AutomationTriggerContextSchema } from "@arden-hq/protocol/effect/automations"
import { decodeJson } from "./json.js"
import {
  AutomationQueue,
  AUTOMATION_BLOCKED_KINDS,
  type AutomationBlockedReport,
  type ObservedAutomationChatRun,
  type ObservedAutomationOccurrence
} from "../automations/queue.js"
import {
  AutomationStoreError,
  type AutomationJobLeaseRef,
  type AutomationQueueSource
} from "../automations/store.js"
import { friendlySessionRef } from "../public-ref.js"
import { nextId } from "./deps.js"
import { insertSession } from "./session-insert.js"
import {
  makeAutomationRowReads,
  systemSpecOf,
  type AutomationStoreDeps
} from "./automation-rows.js"
import { storeError, automationIdEffect } from "./automation-rows.js"
import { enqueue } from "./automation-enqueue.js"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import { activeRunStatusList } from "./status-sets.js"
import { sessionDescendants } from "./tree-walk.js"
import { runAuthorityState, type RunAuthorityState } from "./run-context.js"
import { iso } from "../../runtime/clock.js"
import { parkedOnQuota, quotaPauseUntil } from "./run-wait.js"

interface ObservedChatRunRow {
  readonly status: string
  readonly session_id: string
  readonly paused_until: string | null
  readonly stop_reason: string | null
  readonly error_code: string | null
  readonly error_message: string | null
  readonly result: string | null
  readonly blocked_kind: string | null
  readonly blocked_reason: string | null
  readonly wrote: number
}

const blockedReport = (row: ObservedChatRunRow): AutomationBlockedReport | null => {
  const kind = AUTOMATION_BLOCKED_KINDS.find((candidate) => candidate === row.blocked_kind)
  if (kind === undefined) return null
  const reason = row.blocked_reason?.trim()
  return { kind, reason: reason === undefined || reason === "" ? "No reason given." : reason }
}

const SkippedWakeSchema = Schema.Struct({
  prompt: Schema.String,
  ran: Schema.NullOr(Schema.Unknown)
})

const HEADLINE_BY_SOURCE: Readonly<Record<AutomationQueueSource, string>> = {
  scheduled: "Scheduled check-in",
  manual: "Started by you",
  event: "Reacting to a change",
  idle: "Checked in after a quiet period",
  count: "Checked in after enough activity",
  wake: "Woken to continue"
}

export const makeAutomationRunRequests = ({
  writer,
  sessionEvents,
  rules
}: Pick<AutomationStoreDeps, "writer" | "sessionEvents" | "rules">): Pick<
  AutomationQueue["Service"],
  | "requestRun"
  | "requestRunWithEvent"
  | "prepareRunSession"
  | "observeChatRun"
  | "observeOccurrence"
  | "reportBlocked"
> => {
  const sql = writer.sql
  const { findAutomationRow } = makeAutomationRowReads({ writer, rules })
  const requestRun = Effect.fn("SqliteAutomationStore.requestRun")(function* (
    automationId: string
  ) {
    const validAutomationId = yield* automationIdEffect(automationId, "request_run")
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const row = yield* findAutomationRow(validAutomationId, "request_run")
          if (row === null) return false
          if (
            row.purpose === "system" &&
            !(yield* systemSpecOf(rules, row, "request_run")).manualRun
          ) {
            return yield* storeError(
              "request_run",
              "invalid",
              `${row.name} runs only when its trigger fires; it has no manual run`,
              validAutomationId
            )
          }
          return yield* enqueue(
            { sql, sessionEvents },
            {
              automationId: validAutomationId,
              source: "manual",
              key: yield* nextId,
              pending: "add",
              context: { scheduled_for: null, automation_run_id: null }
            }
          )
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : storeError(
                "request_run",
                "storage",
                "Could not queue Automation",
                validAutomationId,
                cause
              )
        )
      )
  })

  const requestRunWithEvent = Effect.fn("SqliteAutomationStore.requestRunWithEvent")(function* (
    automationId: string,
    skippedRunId: number
  ) {
    const validAutomationId = yield* automationIdEffect(automationId, "request_run")
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly skip_json: string
            readonly trigger_json: string | null
          }>`
            SELECT skip_json, trigger_json FROM automation_runs
            WHERE id = ${skippedRunId} AND task_id = ${validAutomationId} AND json_extract(skip_json, '$.reason') = 'prefilter'
            LIMIT 1
          `
          const row = rows[0]
          if (row === undefined) return false
          const skip = yield* decodeJson(SkippedWakeSchema, row.skip_json)
          if (skip.ran !== null) {
            return yield* storeError(
              "request_run",
              "conflict",
              "This event already ran",
              validAutomationId
            )
          }
          const snapshot =
            row.trigger_json === null
              ? undefined
              : yield* decodeJson(AutomationTriggerContextSchema, row.trigger_json)
          const now = iso(yield* Clock.currentTimeMillis)
          yield* enqueue(
            { sql, sessionEvents },
            {
              automationId: validAutomationId,
              source: "manual",
              key: yield* nextId,
              pending: "add",
              context: {
                scheduled_for: null,
                automation_run_id: null,
                trigger_context: skip.prompt,
                ...(snapshot === undefined ? {} : { trigger_context_snapshot: snapshot }),
                from_skipped_run: skippedRunId
              }
            }
          )
          yield* sql`
            UPDATE automation_runs
            SET skip_json = json_set(skip_json, '$.ran', json_object('at', ${now}, 'run_id', NULL),
              '$.cancelled', json('null'))
            WHERE id = ${skippedRunId}
          `
          return true
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : storeError(
                "request_run",
                "storage",
                "Could not queue the run with this event",
                validAutomationId,
                cause
              )
        )
      )
  })

  const prepareRunSession = Effect.fn("SqliteAutomationStore.prepareRunSession")(function* (
    lease: AutomationJobLeaseRef
  ) {
    const trunk = lease.payload.sessionId
    if (trunk === null) {
      return yield* storeError(
        "prepare_run_session",
        "invalid",
        "Automation has no Chat Session to parent a run under",
        lease.payload.automationId
      )
    }
    const parsed = parseLease(lease)
    const childId = `${trunk}::i${lease.payload.automationRunId}`
    const headlineId = `headline:${childId}`
    const now = iso(yield* Clock.currentTimeMillis)
    yield* transactWithActiveContext(
      writer,
      "ordinary",
      { sessionId: trunk },
      Effect.gen(function* () {
        const live = yield* sql<{ readonly id: number }>`
        SELECT r.id FROM automation_runs AS r
        WHERE r.id = ${parsed.runId}
          AND r.task_id = ${lease.payload.automationId}
          AND r.status = 'running'
          AND EXISTS (
            SELECT 1 FROM automation_event_queue AS q
            WHERE q.id = ${parsed.queueId} AND q.lease_expires_at > ${iso(yield* Clock.currentTimeMillis)}
              AND q.claimed_at IS NOT NULL AND r.claim_count = ${parsed.claimAttempt}
              AND q.task_id = r.task_id AND json_extract(q.context, '$.automation_run_id') = r.id
          )
        LIMIT 1
      `
        if (live[0] === undefined) {
          return yield* storeError(
            "prepare_run_session",
            "conflict",
            "The lease is no longer current, so no run Session was prepared",
            lease.payload.automationId
          )
        }
        const seen = yield* sql<{ readonly message_id: string }>`
        SELECT message_id FROM session_messages
        WHERE session_id = ${trunk} AND message_id = ${headlineId} LIMIT 1
      `
        if (seen[0] === undefined) {
          const next = yield* sql<{ readonly value: number }>`
          SELECT COALESCE(MAX(seq) + 1, 0) AS value FROM session_messages
          WHERE session_id = ${trunk}
        `
          const text = HEADLINE_BY_SOURCE[lease.payload.occurrence]
          const headlineTurnId = (yield* currentSessionTurnId(sql, trunk)) ?? headlineId
          const headlineSeq = next[0]?.value ?? 0
          yield* sql`
          INSERT INTO session_messages (
            session_id, message_id, seq, role, message_json, client_id,
            created_at, search_text
          ) VALUES (
            ${trunk}, ${headlineId}, ${headlineSeq}, 'assistant',
            ${JSON.stringify({
              message_id: headlineId,
              role: "assistant",
              is_meta: true,
              created_at: now,
              content: text,
              turn_id: headlineTurnId
            })},
            NULL, ${now}, ${text}
          )
        `
          yield* hideFromActiveContext(sql, trunk, headlineSeq)
          yield* appendSessionTurn(sql, {
            sessionId: trunk,
            turnId: headlineTurnId,
            firstSequence: headlineSeq,
            messages: [{ message_id: headlineId, created_at: now }]
          })
          yield* sql`
          UPDATE sessions
          SET last_activity = ${now}
          WHERE session_id = ${trunk}
        `
        }
        const child = yield* sql<{ readonly session_id: string }>`
        SELECT session_id FROM sessions WHERE session_id = ${childId} LIMIT 1
      `
        if (child[0] === undefined) {
          const sources = yield* sql<{
            readonly space_id: string | null
            readonly chat_model: string | null
          }>`
          SELECT COALESCE(task.owner_space_id, trunk.space_id) AS space_id, trunk.chat_model
          FROM sessions AS trunk JOIN scheduled_tasks AS task ON task.task_id = ${lease.payload.automationId}
          WHERE trunk.session_id = ${trunk}
        `
          const source = sources[0]
          if (source === undefined) {
            return yield* storeError(
              "prepare_run_session",
              "not_found",
              "The Automation trunk Session is missing, so no run Session was created",
              lease.payload.automationId
            )
          }
          yield* insertSession({
            sql,
            session: {
              type: "chat",
              sessionId: childId,
              publicRef: friendlySessionRef(childId),
              startedAt: now,
              name: null,
              metadata: "{}",
              spaceId: source.space_id,
              chatModel: source.chat_model,
              originAutomationId: lease.payload.automationId,
              parent: { sessionId: trunk, messageId: headlineId }
            },
            lifecycle: { kind: "silent", reason: "run_session" }
          })
        }
      })
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof AutomationStoreError
          ? cause
          : storeError(
              "prepare_run_session",
              "storage",
              "Could not prepare the run Session",
              lease.payload.automationId,
              cause
            )
      )
    )
    return childId
  })

  const observeChatRun = Effect.fn("SqliteAutomationStore.observeChatRun")(function* (
    chatRunId: string
  ) {
    const rows = yield* sql<ObservedChatRunRow>`
      SELECT run.status, run.session_id, run.stop_reason, run.error_code, run.error_message,
             ${quotaPauseUntil(sql, sql`run.metadata_json`)} AS paused_until,
             COALESCE(json_extract(run.metadata_json, '$.terminal_result.text'), message.search_text) AS result,
             json_extract(sidecar.evidence_json, '$.automation_outcome.kind') AS blocked_kind,
             json_extract(sidecar.evidence_json, '$.automation_outcome.reason') AS blocked_reason,
             EXISTS (
               SELECT 1 FROM tool_calls
               WHERE tool_calls.run_id = run.run_id
                 AND tool_calls.changes_state = 1
                 AND tool_calls.status = 'completed'
             ) AS wrote
      FROM chat_runs AS run
      LEFT JOIN session_messages AS message
        ON message.session_id = run.session_id
       AND message.message_id = run.assistant_message_id
      LEFT JOIN run_sidecars AS sidecar ON sidecar.run_id = run.run_id
      WHERE run.run_id = ${chatRunId}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        storeError(
          "observe_chat_run",
          "storage",
          "Could not observe Automation Chat run",
          undefined,
          cause
        )
      )
    )
    const row = rows[0]
    if (row === undefined) return null
    if (isActiveRunStatus(row.status)) {
      return row.status === "pending" && row.paused_until !== null
        ? ({
            status: "paused",
            sessionId: row.session_id,
            until: row.paused_until
          } satisfies ObservedAutomationChatRun)
        : ({ status: "running" } satisfies ObservedAutomationChatRun)
    }
    const blocked = blockedReport(row)
    const wrote = row.wrote === 1
    if (row.status === "completed") {
      return {
        status: "completed",
        result: row.result,
        error: null,
        errorCode: null,
        blocked,
        wrote
      } satisfies ObservedAutomationChatRun
    }
    return {
      status: row.status === "cancelled" ? "cancelled" : "failed",
      result: row.result,
      error: row.error_message ?? row.stop_reason ?? row.error_code ?? `Chat run ${row.status}`,
      errorCode: Schema.is(ChatRunErrorCodeSchema)(row.error_code) ? row.error_code : null,
      blocked,
      wrote
    } satisfies ObservedAutomationChatRun
  })

  const observeOccurrence = Effect.fn("SqliteAutomationStore.observeOccurrence")(function* (
    attemptId: number
  ) {
    const rows = yield* sql<{
      readonly final_run_id: string | null
      readonly session_id: string | null
      readonly working: number
      readonly arriving: number
      readonly authority: RunAuthorityState | null
      readonly paused_until: string | null
      readonly paused_session_id: string | null
    }>`
      WITH RECURSIVE attempt AS (
        SELECT origin, chat_session_id FROM automation_runs WHERE id = ${attemptId}
      ),
      own AS (
        SELECT run.run_id, run.session_id, run.status, run.started_at, run.metadata_json
        FROM chat_runs AS run JOIN attempt ON run.session_id = attempt.chat_session_id
        WHERE json_extract(run.metadata_json, '$.run_context.origin') = json(attempt.origin)
      ),
      ${sessionDescendants(sql, {
        name: "tree",
        from: sql`SELECT child.session_id FROM sessions AS child JOIN attempt
          ON child.parent_session_id = attempt.chat_session_id
          WHERE child.session_type = 'agent'`,
        where: sql`child.session_type = 'agent'`,
        depth: { max: 63 }
      })},
      -- Drive from descendant Sessions so each Run lookup uses the session index,
      -- rather than scanning every historical Run on each poll.
      members AS (
        SELECT run_id, session_id, status, metadata_json FROM own
        UNION ALL
        SELECT run.run_id, run.session_id, run.status, run.metadata_json
        FROM tree CROSS JOIN chat_runs AS run ON run.session_id = tree.session_id
        WHERE json_extract(run.authority_json, '$.delegation.chain[0]') IN (SELECT run_id FROM own)
      ),
      paused AS (
        SELECT session_id, ${quotaPauseUntil(sql, sql`metadata_json`)} AS until FROM members
        WHERE ${parkedOnQuota(sql, sql`status`, sql`metadata_json`)}
      )
      SELECT
        (SELECT run_id FROM own ORDER BY started_at DESC, run_id DESC LIMIT 1) AS final_run_id,
        (SELECT chat_session_id FROM attempt) AS session_id,
        (SELECT ${runAuthorityState(sql, sql`metadata_json`, sql`run_id`)} FROM own
          ORDER BY started_at DESC, run_id DESC LIMIT 1) AS authority,
        (SELECT COUNT(*) FROM members WHERE status IN ${activeRunStatusList}
          AND NOT ${parkedOnQuota(sql, sql`status`, sql`metadata_json`)}) AS working,
        EXISTS (SELECT 1 FROM automation_deliveries AS delivery
          WHERE delivery.status = 'pending'
            AND json_extract(delivery.payload, '$.kind') IN ('result', 'answer')
            AND json_extract(delivery.payload, '$.runIds[0]') IN (SELECT run_id FROM members)
            AND json_extract(delivery.payload, '$.sessionId') IN (SELECT session_id FROM members)) AS arriving,
        (SELECT MAX(until) FROM paused) AS paused_until,
        (SELECT session_id FROM paused ORDER BY until DESC LIMIT 1) AS paused_session_id
    `.pipe(
      Effect.mapError((cause) =>
        storeError(
          "observe_chat_run",
          "storage",
          "Could not observe the Automation occurrence",
          undefined,
          cause
        )
      )
    )
    const row = rows[0]
    if (row === undefined || row.final_run_id === null || row.session_id === null) return null
    if (row.working > 0 || (row.arriving === 1 && row.authority === "active")) {
      return { status: "running" } satisfies ObservedAutomationOccurrence
    }
    if (row.paused_until !== null && row.paused_session_id !== null) {
      return {
        status: "paused",
        sessionId: row.paused_session_id,
        until: row.paused_until
      } satisfies ObservedAutomationOccurrence
    }
    const final = yield* observeChatRun(row.final_run_id)
    if (final === null || final.status === "running" || final.status === "paused") return final
    return {
      ...final,
      runId: row.final_run_id,
      sessionId: row.session_id
    } satisfies ObservedAutomationOccurrence
  })

  const reportBlocked = Effect.fn("SqliteAutomationStore.reportBlocked")(function* (input: {
    readonly sessionId: string
    readonly chatRunId: string
    readonly report: AutomationBlockedReport
  }) {
    const timestamp = iso(yield* Clock.currentTimeMillis)
    yield* writer
      .run(
        recordBlockedAutomationInTransaction(sql, {
          runId: input.chatRunId,
          sessionId: input.sessionId,
          kind: input.report.kind,
          reason: input.report.reason,
          updatedAt: timestamp
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          storeError(
            "observe_chat_run",
            "storage",
            "Could not record the Automation outcome",
            undefined,
            cause
          )
        ),
        Effect.asVoid
      )
  })

  return {
    requestRun,
    requestRunWithEvent,
    prepareRunSession,
    observeChatRun,
    observeOccurrence,
    reportBlocked
  }
}
