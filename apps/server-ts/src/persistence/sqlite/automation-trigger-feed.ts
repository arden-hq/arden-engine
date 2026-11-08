import { makeAutomationEventDispatch } from "./automation-event-dispatch.js"
import { makeAutomationEventFeeds, readTaskHistory } from "./automation-event-feeds.js"
import { readOpenAsk } from "./automation-ask-feed.js"
import { cooldownEnd } from "./automation-enqueue.js"
import type { EventAutomationTrigger } from "@arden-hq/protocol/automations"
import { readHeadSequence } from "@arden-hq/journal/effect"
import { Clock, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { AutomationStoreError } from "../automations/store.js"
import { AutomationTriggers, type TriggerFeedRecord } from "../automations/triggers.js"
import type { WikiEventOutbox } from "../automations/wiki-event-outbox.js"
import { SESSION_LIFECYCLE_STREAM_ID } from "../sessions/events.js"
import { makeSpaceJobSql } from "./space-jobs.js"
import { listenerTriggers } from "./automation-schedule.js"
import type { AutomationStoreDeps } from "./automation-rows.js"
import { makeTriggerArming } from "./automation-trigger-arming.js"
import { listensFor, listensForEvents } from "./automation-listening.js"
import { armChatQuiet, loadQuietChat } from "./automation-chat-quiet.js"
import type { EventChat, JournalReads, QuietChat } from "../automations/model.js"
import { type StoreOperation, storeError } from "./automation-rows.js"
import { iso } from "../../runtime/clock.js"

export const makeAutomationTriggerFeed = ({
  writer,
  sessionEvents,
  rules
}: Pick<AutomationStoreDeps, "writer" | "sessionEvents" | "rules">): {
  readonly triggers: AutomationTriggers["Service"]
  readonly outbox: WikiEventOutbox["Service"]
} => {
  const sql = writer.sql
  const spaceJobs = makeSpaceJobSql(sql, sessionEvents)
  const { listeningAutomations, armTrigger, rearmAutomation } = makeTriggerArming({
    writer,
    sessionEvents
  })
  const eventDispatch = makeAutomationEventDispatch({ writer, sessionEvents, rules })
  const unread = Effect.mapError((cause: unknown) =>
    storeError(
      "trigger_feed",
      "storage",
      "Could not read what a journal record names",
      undefined,
      cause
    )
  )
  const journalReads: JournalReads = {
    chat: (sessionId) => loadEventChat(sql, sessionId).pipe(unread),
    taskHistory: (eventId) => readTaskHistory(sql, eventId).pipe(unread),
    openAsk: (ask) => readOpenAsk(sql, ask).pipe(unread)
  }
  const readTriggerCursor = Effect.fn("SqliteAutomationStore.readTriggerCursor")(function* (
    operation: StoreOperation
  ) {
    const rows = yield* sql<{ readonly after_sequence: number }>`
      SELECT after_sequence FROM automation_trigger_cursor
      WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        storeError(
          operation,
          "storage",
          "Could not read the trigger-listener cursor",
          undefined,
          cause
        )
      )
    )
    return rows[0]?.after_sequence ?? 0
  })

  const triggerCursor = Effect.fn("SqliteAutomationStore.triggerCursor")(function* () {
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const head = (yield* readHeadSequence(sql, SESSION_LIFECYCLE_STREAM_ID)) ?? 0
          const rows = yield* sql<{ readonly after_sequence: number }>`
          SELECT after_sequence FROM automation_trigger_cursor
          WHERE stream_id = ${SESSION_LIFECYCLE_STREAM_ID}
          LIMIT 1
        `
          const stored = rows[0]?.after_sequence
          if (stored !== undefined) return { afterSequence: stored, head }
          yield* sql`
          INSERT INTO automation_trigger_cursor (stream_id, after_sequence)
          VALUES (${SESSION_LIFECYCLE_STREAM_ID}, ${head})
        `
          return { afterSequence: head, head }
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : storeError(
                "trigger_feed",
                "storage",
                "Could not initialize the trigger-listener cursor",
                undefined,
                cause
              )
        )
      )
  })

  const applyTriggerFeedRecord = Effect.fn("SqliteAutomationStore.applyTriggerFeedRecord")(
    function* (record: TriggerFeedRecord): Effect.fn.Return<void, AutomationStoreError> {
      return yield* writer
        .transact(
          Effect.gen(function* () {
            const cursor = yield* readTriggerCursor("trigger_feed")
            if (record.sequence <= cursor) return
            const nowMs = yield* Clock.currentTimeMillis
            if (record.journal !== undefined)
              for (const raised of yield* rules.fromJournal(record.journal, journalReads))
                yield* eventDispatch.dispatchInTransaction(
                  raised.event,
                  raised.dueAt === undefined ? {} : { dueAt: raised.dueAt }
                )
            if (record.kind === "run_completed" && record.sessionId !== null)
              yield* spaceJobs.queueInferenceChat(record.sessionId, iso(nowMs))
            if (record.kind !== "other" && record.sessionId !== null) {
              const sessionId = record.sessionId
              let quietChat: QuietChat | null | undefined
              for (const task of yield* listeningAutomations("trigger_feed")) {
                if (task.chatQuiet !== null && record.kind !== "run_completed") {
                  quietChat ??= yield* loadQuietChat(sql, sessionId)
                  if (quietChat !== null) {
                    yield* armChatQuiet({
                      writer: { sql, sessionEvents },
                      rules,
                      automationId: task.automationId,
                      trigger: task.chatQuiet,
                      chat: quietChat,
                      atMs: record.atMs,
                      nowMs
                    })
                  }
                }
                if (task.idle !== null && record.kind === "input_committed") {
                  yield* sql`INSERT INTO automation_idle_state (task_id, latest_input_sequence, latest_input_at)
                      VALUES (${task.automationId}, ${record.sequence}, ${iso(record.atMs)})
                      ON CONFLICT(task_id) DO UPDATE SET
                        latest_input_sequence = excluded.latest_input_sequence,
                        latest_input_at = excluded.latest_input_at
                      WHERE excluded.latest_input_sequence > automation_idle_state.latest_input_sequence`
                  yield* armTrigger(task.automationId, record.atMs + task.idle * 60_000, {
                    source: "idle",
                    queued_at: iso(nowMs),
                    input_sequence: record.sequence,
                    input_at: iso(record.atMs)
                  })
                }
                if (
                  task.count !== null &&
                  record.kind === "run_completed" &&
                  record.atMs >=
                    ((yield* cooldownEnd(sql, task.automationId)) ?? Number.NEGATIVE_INFINITY)
                ) {
                  const counted = yield* sql<{ readonly count: number }>`
                INSERT INTO automation_count_state (task_id, session_id, count, updated_at, through_sequence)
                VALUES (${task.automationId}, ${record.sessionId}, 1, ${iso(nowMs)}, ${record.sequence})
                ON CONFLICT (task_id, session_id)
                DO UPDATE SET count = count + 1, updated_at = ${iso(nowMs)}, through_sequence = ${record.sequence}
                RETURNING count
              `
                  if ((counted[0]?.count ?? 0) >= task.count) {
                    yield* armTrigger(task.automationId, record.atMs, {
                      source: "count",
                      queued_at: iso(nowMs),
                      session_id: record.sessionId,
                      through_sequence: record.sequence,
                      every_n: task.count
                    })
                    yield* sql`
                    DELETE FROM automation_count_state
                    WHERE task_id = ${task.automationId} AND session_id = ${record.sessionId}
                  `
                  }
                }
              }
            }
            yield* sql`
          INSERT INTO automation_trigger_cursor (stream_id, after_sequence)
          VALUES (${SESSION_LIFECYCLE_STREAM_ID}, ${record.sequence})
          ON CONFLICT (stream_id) DO UPDATE SET after_sequence = ${record.sequence}
        `
          })
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof AutomationStoreError
              ? cause
              : storeError(
                  "trigger_feed",
                  "storage",
                  "Could not apply the trigger feed record",
                  undefined,
                  cause
                )
          )
        )
    }
  )

  const listeningEventTriggers = Effect.fn("SqliteAutomationStore.listeningEventTriggers")(
    function* (): Effect.fn.Return<ReadonlyArray<EventAutomationTrigger>, AutomationStoreError> {
      const rows = yield* sql<{
        readonly task_id: string
        readonly triggers: string
        readonly paused_at: string | null
      }>`
      SELECT task_id, triggers, paused_at
      FROM scheduled_tasks
      WHERE ${listensForEvents(sql, sql`scheduled_tasks`)}
        AND purpose IN ('user_automation', 'system')
      ORDER BY task_id
    `.pipe(
        Effect.mapError((cause) =>
          storeError(
            "event_triggers",
            "storage",
            "Could not inspect live Automation event triggers",
            undefined,
            cause
          )
        )
      )
      const events: Array<EventAutomationTrigger> = []
      for (const row of rows) {
        for (const trigger of (yield* listenerTriggers(row)) ?? []) {
          if (
            trigger.type === "event" &&
            listensFor({ pausedAt: row.paused_at, eventType: trigger.event_type })
          )
            events.push(trigger)
        }
      }
      return events
    }
  )

  const rearmIdleTriggers = Effect.fn("SqliteAutomationStore.rearmIdleTriggers")(function* () {
    yield* writer
      .transact(
        Effect.gen(function* () {
          const tasks = (yield* listeningAutomations("rearm_idle")).filter(
            (task) => task.idle !== null
          )
          if (tasks.length === 0) return
          const nowMs = yield* Clock.currentTimeMillis
          for (const task of tasks) {
            yield* rearmAutomation({ ...task, count: null }, nowMs)
          }
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : storeError(
                "rearm_idle",
                "storage",
                "Could not re-arm idle triggers",
                undefined,
                cause
              )
        )
      )
  })

  return {
    triggers: AutomationTriggers.of({
      triggerCursor,
      applyTriggerFeedRecord,
      dispatchEvent: eventDispatch.dispatchEvent,
      ...makeAutomationEventFeeds({
        writer,
        rules,
        dispatchInTransaction: eventDispatch.dispatchInTransaction
      }),
      listeningEventTriggers,
      rearmIdleTriggers
    }),
    outbox: eventDispatch.outbox
  }
}

const loadEventChat = (sql: SqlClient.SqlClient, sessionId: string) =>
  sql<{
    readonly public_ref: string
    readonly name: string | null
    readonly space_name: string | null
  }>`
    SELECT chat.public_ref, chat.name, space.name AS space_name
    FROM sessions AS chat LEFT JOIN spaces AS space ON space.space_id = chat.space_id
    WHERE chat.session_id = ${sessionId}`.pipe(
    Effect.map(([chat]): EventChat | undefined =>
      chat === undefined
        ? undefined
        : {
            sessionId,
            publicRef: chat.public_ref,
            name: chat.name ?? undefined,
            spaceName: chat.space_name ?? undefined
          }
    )
  )
