import { Clock, Effect, Schema } from "effect"

import type { AutomationJobLeaseRef } from "../automations/store.js"
import { AutomationStoreError } from "../automations/store.js"
import { friendlySessionRef } from "../public-ref.js"
import { makeSessionForkOrigin, prepareForkContext } from "./session-fork.js"
import { parseLease } from "./automation-lease.js"
import type { AutomationStoreDeps } from "./automation-rows.js"
import { storeError } from "./automation-rows.js"
import { appendMessagesInTransaction, loadActiveMessages } from "./chat-transcript.js"
import { insertSession } from "./session-insert.js"
import { iso } from "../../runtime/clock.js"
import { isUserAutomationPurpose } from "../job-classification.js"

const ForkSourceSchema = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("event"),
    event_type: Schema.Literal("chat.quiet"),
    context: Schema.Struct({
      chat: Schema.Struct({ session_id: Schema.NonEmptyString })
    })
  }),
  Schema.Struct({ source: Schema.Literal("count"), session_id: Schema.NonEmptyString })
])

const forkSource = (run: {
  readonly trigger_json: string | null
  readonly purpose: string
  readonly thread_id: string | null
}): string | undefined => {
  if (isUserAutomationPurpose(run.purpose)) return run.thread_id ?? undefined
  const trigger = Schema.decodeUnknownOption(Schema.fromJsonString(ForkSourceSchema))(
    run.trigger_json ?? ""
  )
  if (trigger._tag === "None") return undefined
  return trigger.value.source === "count"
    ? trigger.value.session_id
    : trigger.value.context.chat.session_id
}

export const makeForkSessions = ({ writer }: Pick<AutomationStoreDeps, "writer">) => {
  const sql = writer.sql
  const prepareForkSession = Effect.fn("SqliteAutomationStore.prepareForkSession")(function* (
    lease: AutomationJobLeaseRef
  ) {
    const parsed = parseLease(lease)
    const forkId = `fork:${lease.payload.automationRunId}`
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const runs = yield* sql<{
            readonly trigger_json: string | null
            readonly purpose: string
            readonly thread_id: string | null
          }>`
            SELECT r.trigger_json, task.purpose, task.thread_id FROM automation_runs AS r
            JOIN scheduled_tasks AS task ON task.task_id = r.task_id
            WHERE r.id = ${parsed.runId} AND r.task_id = ${lease.payload.automationId}
              AND r.status = 'running' AND r.claim_count = ${parsed.claimAttempt}
              AND EXISTS (
                SELECT 1 FROM automation_event_queue AS q
                WHERE q.id = ${parsed.queueId} AND q.task_id = r.task_id AND q.claimed_at IS NOT NULL
                  AND q.lease_expires_at > ${iso(yield* Clock.currentTimeMillis)}
                  AND json_extract(q.context, '$.automation_run_id') = r.id
              )
          `
          const run = runs[0]
          if (run === undefined) {
            return yield* storeError(
              "prepare_run_session",
              "conflict",
              "The lease is no longer current, so no fork was prepared",
              lease.payload.automationId
            )
          }
          const sourceId = forkSource(run)
          if (sourceId === undefined) return null
          const childId = `${sourceId}::f${lease.payload.automationRunId}`
          const existing = yield* sql<{ readonly session_id: string }>`
            SELECT session_id FROM sessions WHERE session_id = ${childId}
          `
          const fork = { sessionId: childId, sourceSessionId: sourceId }
          if (existing[0] !== undefined) return fork
          const sources = yield* sql<{
            readonly public_ref: string
            readonly space_id: string | null
            readonly model: string | null
            readonly last_message_id: string | null
            readonly last_seq: number | null
          }>`
            SELECT s.public_ref, s.space_id,
                   COALESCE(s.chat_model, (SELECT model_id FROM chat_runs WHERE session_id = s.session_id
                     ORDER BY started_at DESC LIMIT 1)) AS model,
                   (SELECT message_id FROM session_messages WHERE session_id = s.session_id
                     ORDER BY seq DESC LIMIT 1) AS last_message_id,
                   (SELECT MAX(seq) FROM session_messages WHERE session_id = s.session_id) AS last_seq
            FROM sessions AS s
            WHERE s.session_id = ${sourceId} AND s.archived_at IS NULL
          `
          const source = sources[0]
          if (source === undefined || source.last_message_id === null || source.last_seq === null) {
            return null
          }
          const timestamp = iso(yield* Clock.currentTimeMillis)
          yield* insertSession({
            sql,
            session: {
              type: "chat",
              sessionId: childId,
              publicRef: friendlySessionRef(childId),
              startedAt: timestamp,
              name: null,
              metadata: JSON.stringify({
                fork_origin: yield* makeSessionForkOrigin({
                  sourceSessionId: sourceId,
                  sourceSessionRef: source.public_ref,
                  throughSequence: source.last_seq,
                  sourceMessageId: source.last_message_id,
                  createdAt: timestamp
                })
              }),
              spaceId: source.space_id,
              chatModel: source.model,
              originAutomationId: lease.payload.automationId,
              parent: { sessionId: sourceId, messageId: source.last_message_id }
            },
            lifecycle: { kind: "silent", reason: "run_session" }
          })
          const history = yield* loadActiveMessages(sql, sourceId, "fork_session")
          const forked = yield* prepareForkContext({
            history,
            parentSessionId: sourceId,
            forkId,
            closeOpenCall: () =>
              "This call belongs to the chat this one was forked from; its result is not available here.",
            timestamp,
            operation: "fork_session",
            presentation: "inherited"
          })
          const [first] = forked
          if (first !== undefined) {
            yield* appendMessagesInTransaction(
              sql,
              childId,
              forked,
              timestamp,
              "fork_session",
              first.message_id
            )
          }
          return fork
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AutomationStoreError
            ? cause
            : storeError(
                "prepare_run_session",
                "storage",
                "Could not prepare the fork Session",
                lease.payload.automationId,
                cause
              )
        )
      )
  })
  return { prepareForkSession }
}
