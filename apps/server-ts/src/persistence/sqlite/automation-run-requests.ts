import { JOB_SUBJECT_KIND } from "../space-job-id.js"
import { JOB_PURPOSE } from "../job-classification.js"
import { INTERACTION_KIND, INTERACTION_SOURCE, ROLE } from "@arden-hq/std/message-vocabulary"
import { recordBlockedAutomationInTransaction } from "./run-sidecar-mutations.js"
import { parseLease } from "./automation-lease.js"
import { appendSessionTurn, currentSessionTurnId } from "./turns.js"
import { hideFromActiveContext } from "./active-context.js"
import { Clock, Effect } from "effect"
import { AutomationTriggerContextSchema } from "@arden-hq/protocol/effect/automations"
import { decodeJson } from "./json.js"
import { askedToRun, SkippedWakeSchema } from "./automation-run-rows.js"
import { AutomationQueue, type AutomationBlockedReport } from "../automations/queue.js"
import {
  AutomationStoreError,
  type AutomationJobLeaseRef,
  type AutomationQueueSource
} from "../automations/store.js"
import { friendlySessionRef } from "../public-ref.js"
import { nextId } from "./deps.js"
import { insertSession } from "./session-insert.js"
import { systemSpecOf, type AutomationStoreDeps } from "./automation-rows.js"
import { storeError, automationIdEffect, readWorkOwner, type WorkOwner } from "./automation-rows.js"
import { attemptRunSessionId } from "./owner-chat.js"
import { enqueue } from "./automation-enqueue.js"
import { iso } from "../../runtime/clock.js"
import { makeAutomationRowReads } from "./automation-row-reads.js"
import { makeAutomationRunObservation } from "./automation-run-observation.js"

const HEADLINE_BY_SOURCE: Readonly<Record<AutomationQueueSource, string>> = {
  scheduled: "Scheduled check-in",
  manual: "Started by you",
  event: "Reacting to a change",
  idle: "Checked in after a quiet period",
  count: "Checked in after enough activity",
  wake: "Woken to continue"
}

const childSource = (
  trunkRow: { readonly space_id: string | null; readonly chat_model: string | null } | undefined,
  owner: WorkOwner | undefined,
  trunk: string
) => {
  if (trunkRow === undefined) return undefined
  if (owner?.kind === JOB_SUBJECT_KIND.automation) return trunkRow
  if (owner?.kind === JOB_SUBJECT_KIND.spaceReview && owner.chatId === trunk)
    return { ...trunkRow, space_id: owner.spaceId }
  return undefined
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
  const { observeChatRun, observeOccurrence } = makeAutomationRunObservation(sql)
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
            row.purpose === JOB_PURPOSE.system &&
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
          if (askedToRun(skip.run_with_event)) {
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
            SET skip_json = json_set(skip_json, '$.run_with_event', json_object('kind', 'queued', 'at', ${now}))
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
    const childId = attemptRunSessionId(trunk, lease.payload.automationRunId)
    const headlineId = `headline:${childId}`
    const now = iso(yield* Clock.currentTimeMillis)
    yield* writer
      .transact(
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
            created_at, search_text, author
          ) VALUES (
            ${trunk}, ${headlineId}, ${headlineSeq}, 'interaction',
            ${JSON.stringify({
              message_id: headlineId,
              role: ROLE.interaction,
              from: { source: INTERACTION_SOURCE.harness, id: "automation_headline" },
              kind: INTERACTION_KIND.event,
              created_at: now,
              content: text,
              turn_id: headlineTurnId
            })},
            NULL, ${now}, ${text}, 'app'
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
            const owner = yield* readWorkOwner(sql, lease.payload.automationId)
            const sources = yield* sql<{
              readonly space_id: string | null
              readonly chat_model: string | null
            }>`
          SELECT trunk.space_id, trunk.chat_model FROM sessions AS trunk
          WHERE trunk.session_id = ${trunk}
        `
            const source = childSource(sources[0], owner, trunk)
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
      )
      .pipe(
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
