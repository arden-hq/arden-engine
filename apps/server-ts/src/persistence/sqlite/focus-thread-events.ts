import {
  FOCUS_CHOICE_DECISION,
  FOCUS_CHOICE_STATUS,
  FOCUS_CHOICE_TARGET
} from "@arden-hq/protocol/sessions/focus-choices"
import { THREAD_LOCATION, THREAD_STEP } from "../focus-choices/thread-location.js"
import { RunContextSchema } from "../runs/stored-context.js"
import { parseJsonText } from "@arden-hq/protocol/common"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import { isWrittenByPerson } from "../transcript/model.js"
import { ChatForwardedSourceSchema } from "@arden-hq/protocol/effect/chat"
import { Effect, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { SessionStoreError } from "../sessions/store.js"
import { appendQuestionChange } from "./question-events.js"
import { answerQuestionInTransaction } from "./question-settle.js"
import { decodeJson } from "./json.js"
import { nextId } from "./deps.js"
import { createSessionInTransaction } from "./session-lifecycle.js"
import type { StoredThread } from "../sessions/thread.js"
import { writeError } from "./chat-write-errors.js"
import { userContent } from "../transcript/user-content.js"
import {
  threadStep,
  type ThreadEvent,
  type ThreadEffects,
  type ThreadLocation
} from "../focus-choices/thread-location.js"
import { messageTurnIdSql } from "./message-turns.js"
import { userChatSql } from "./chat-ownership.js"
import { enqueueRunDelivery } from "./work-delivery-routing.js"
import { type FocusChoiceRow, internalTargetSchema, failure } from "./focus-choice-rows.js"

const locationOf = (row: FocusChoiceRow): ThreadLocation => {
  if (row.status === FOCUS_CHOICE_STATUS.offered) return { kind: THREAD_LOCATION.waiting }
  return row.decision === FOCUS_CHOICE_DECISION.openTarget
    ? { kind: THREAD_LOCATION.target }
    : { kind: THREAD_LOCATION.source }
}

const triggeringMessage = Effect.fn("FocusChoice.triggeringMessage")(function* (
  sql: SqlClient.SqlClient,
  row: FocusChoiceRow
) {
  const rows = yield* sql<{
    readonly message_id: string
    readonly message_json: string
  }>`SELECT message.message_id, message.message_json
    FROM run_questions AS question
    JOIN chat_runs AS run ON run.run_id = question.run_id
    JOIN session_messages AS message ON message.session_id = ${row.source_session_id}
      AND ${messageTurnIdSql(sql, "message")} = json_extract(run.metadata_json, '$.turn_id')
    WHERE question.question_id = ${row.question_id}
      AND ((message.role = ${ROLE.user}
          AND json_type(message.message_json, '$.question_answer') IS NULL)
        OR (message.role = ${ROLE.interaction}
          AND json_type(message.message_json, '$.forwarded_from') = 'object'))
    ORDER BY message.seq`
  for (const row of rows) {
    const stored: unknown = parseJsonText(row.message_json)
    if (!Predicate.isObject(stored)) continue
    if (
      !isWrittenByPerson({ role: String(stored.role), question_answer: stored.question_answer }) &&
      !Schema.is(ChatForwardedSourceSchema)(stored.forwarded_from)
    )
      continue
    return { messageId: row.message_id, text: userContent(stored.content).text }
  }
  return undefined
})

export const applyThreadEventInTransaction = Effect.fn("FocusChoice.applyThreadEvent")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly sessionEvents: SessionLifecycleEvents["Service"]
    readonly row: FocusChoiceRow
    readonly event: ThreadEvent
    readonly clientId: string
    readonly now: string
  }) {
    const { sql, sessionEvents, row, now } = options
    const step = threadStep(locationOf(row), options.event)
    if (step.kind === THREAD_STEP.refused) return yield* failure("conflict", step.reason)
    if (step.kind === THREAD_STEP.unchanged) return step
    const storedTarget = yield* decodeJson(internalTargetSchema, row.target_json).pipe(
      Effect.mapError((cause) => failure("storage", "Stored Focus choice is corrupt", cause))
    )
    const sources = yield* sql<{
      readonly session_id: string
      readonly public_ref: string
      readonly name: string | null
    }>`SELECT source.session_id, source.public_ref, source.name FROM sessions AS source
    JOIN spaces AS space ON space.space_id = source.space_id
    WHERE source.session_id = ${row.source_session_id}
      AND source.space_id = ${row.space_id}
      AND source.archived_at IS NULL
      AND ${userChatSql("source")}
      AND source.parent_session_id IS NULL
      AND source.parent_message_id IS NULL
      AND space.archived_at IS NULL
     `
    const source = sources[0]
    if (source === undefined) {
      return yield* failure("conflict", "The source conversation or Space is unavailable")
    }
    const asked = (yield* sql<{ readonly run_id: string; readonly context: string }>`
      SELECT question.run_id, json_extract(run.metadata_json, '$.run_context') AS context
      FROM run_questions AS question JOIN chat_runs AS run ON run.run_id = question.run_id
      WHERE question.question_id = ${row.question_id}`)[0]
    if (asked === undefined) return yield* failure("storage", "The thread's question is missing")
    const context = yield* decodeJson(RunContextSchema, asked.context).pipe(
      Effect.mapError((cause) => failure("storage", "Focus choice Run context is corrupt", cause))
    )

    let targetSessionId = row.target_session_id
    if (step.location === THREAD_LOCATION.target && targetSessionId === null) {
      if (storedTarget.kind === FOCUS_CHOICE_TARGET.existing) {
        const targets = yield* sql<{ readonly session_id: string }>`SELECT session_id FROM sessions
        WHERE session_id = ${storedTarget.session_id}
          AND public_ref = ${storedTarget.session_ref}
          AND space_id = ${row.space_id}
          AND archived_at IS NULL
          AND session_type = 'chat'
          AND parent_session_id IS NULL
          AND parent_message_id IS NULL
          AND origin_automation_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM space_conversations WHERE session_id = sessions.session_id
          )`
        if (targets[0] === undefined) {
          return yield* failure("conflict", "The Focus target is no longer available")
        }
        targetSessionId = targets[0].session_id
      } else {
        targetSessionId = yield* nextId
        yield* createSessionInTransaction({
          sql,
          sessionEvents,
          sessionId: targetSessionId,
          timestamp: now,
          session: { name: storedTarget.name, spaceId: row.space_id }
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof SessionStoreError
              ? failure(cause.reason, cause.message, cause)
              : failure("storage", "Could not create the Focus target", cause)
          )
        )
        const thread: StoredThread = {
          source_session_id: source.session_id,
          source_session_ref: source.public_ref,
          source_turn_id: storedTarget.source_turn_id,
          purpose: storedTarget.purpose ?? storedTarget.name,
          starts_with: storedTarget.starts_with ?? []
        }
        yield* sql`UPDATE sessions
        SET metadata = json_set(COALESCE(metadata, '{}'), '$.thread', json(${JSON.stringify(thread)}))
        WHERE session_id = ${targetSessionId}`
      }
    }
    const owner = step.location === THREAD_LOCATION.target ? targetSessionId : source.session_id
    if (owner === null) return yield* failure("storage", "The thread's target chat is missing")

    if (row.status === FOCUS_CHOICE_STATUS.offered) {
      yield* answerQuestionInTransaction({
        sql,
        questionId: row.question_id,
        clientId: options.clientId,
        answer: {
          kind: "choice",
          choice_id:
            step.location === THREAD_LOCATION.target
              ? FOCUS_CHOICE_DECISION.openTarget
              : FOCUS_CHOICE_DECISION.continueHere
        },
        now
      })
    }
    yield* sql`UPDATE focus_choices SET
      status = 'settled',
      decision = ${step.location === THREAD_LOCATION.target ? FOCUS_CHOICE_DECISION.openTarget : FOCUS_CHOICE_DECISION.continueHere},
      result_session_id = ${owner},
      target_session_id = ${targetSessionId},
      settlement_client_id = ${options.clientId},
      transition = ${step.transition},
      transitioned_at = ${now},
      revision = revision + 1,
      updated_at = ${now},
      settled_at = COALESCE(settled_at, ${now})
      WHERE choice_id = ${row.choice_id}`
    yield* sql`UPDATE automation_deliveries SET status = 'discarded'
      WHERE status = 'pending' AND json_extract(payload, '$.kind') = 'thread'
        AND json_extract(payload, '$.questionId') = ${row.question_id}`
    const effects: ThreadEffects = step.effects
    if (effects.forwardToTarget && targetSessionId !== null) {
      const message = yield* triggeringMessage(sql, row)
      if (message === undefined) {
        return yield* failure("storage", "The message that started the thread is missing")
      }
      yield* enqueueRunDelivery({
        sql,
        eventId: `thread:${row.question_id}:${row.revision + 1}`,
        now,
        subject: "Thread moved here",
        body: message.text,
        payload: {
          kind: "thread",
          sessionId: targetSessionId,
          context,
          runIds: [asked.run_id],
          questionId: row.question_id,
          revision: row.revision + 1,
          forwarded: { sessionId: row.source_session_id, messageId: message.messageId }
        }
      }).pipe(Effect.mapError((cause) => failure("storage", cause.message, cause)))
    }
    if (effects.answerSource) {
      yield* enqueueRunDelivery({
        sql,
        eventId: `question-answer:${row.question_id}`,
        now,
        subject: "Answer to your question",
        body: `<question_answer>${JSON.stringify({
          question_id: row.question_id,
          answer: "Continue here",
          instruction: "The user chose to continue this thread here. Continue it in this chat now."
        })}</question_answer>`,
        payload: {
          kind: "answer",
          sessionId: source.session_id,
          context,
          runIds: [asked.run_id],
          questionId: row.question_id
        }
      }).pipe(Effect.mapError((cause) => failure("storage", cause.message, cause)))
    }
    yield* appendQuestionChange({ sql, sessionEvents, questionId: row.question_id })
    return step
  }
)

export const settleTypedHereInTransaction = Effect.fn("FocusChoice.settleTypedHere")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly sessionEvents: SessionLifecycleEvents["Service"]
    readonly input: { readonly sessionId: string; readonly clientId: string }
    readonly now: string
  }) {
    const { input } = options
    const waiting = yield* options.sql<FocusChoiceRow>`SELECT choice.*, NULL AS result_session_ref
      FROM focus_choices AS choice
      WHERE choice.source_session_id = ${input.sessionId} AND choice.status = 'offered'`
    for (const row of waiting) {
      yield* applyThreadEventInTransaction({
        sql: options.sql,
        sessionEvents: options.sessionEvents,
        row,
        event: { kind: "typed_here" },
        clientId: input.clientId,
        now: options.now
      })
    }
  },
  Effect.mapError((cause) =>
    writeError("start", "storage", "Could not settle the waiting thread choice", { cause })
  )
)
