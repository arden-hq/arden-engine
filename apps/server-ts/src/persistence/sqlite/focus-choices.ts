import type { FocusChoice } from "@arden-hq/protocol/sessions/focus-choices"
import {
  FocusChoiceSchema,
  ResolveFocusChoiceInputSchema
} from "@arden-hq/protocol/effect/sessions/focus-choices"
import { ChatForwardedSourceSchema } from "@arden-hq/protocol/effect/chat"
import { RunContextSchema } from "@arden-hq/protocol/effect/runs"
import { DateTime, Effect, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import {
  FocusChoiceStore,
  FocusChoiceStoreError,
  type ThreadRecord
} from "../focus-choices/store.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { SessionStoreError } from "../sessions/store.js"
import type { FocusQuestionTargetInput } from "../work/store.js"
import { WorkStoreError } from "../work/store.js"
import { appendQuestionChange } from "./question-events.js"
import { answerQuestionInTransaction } from "./question-settle.js"
import { runColumns, runDestinationSessionId } from "./run-destination.js"
import { decodeJson } from "./json.js"
import type { Writer } from "./deps.js"
import { nextId } from "./deps.js"
import { createSessionInTransaction } from "./session-lifecycle.js"
import type { StoredThread } from "../sessions/thread.js"
import { runMayActSql } from "./run-liveness.js"
import { writeError } from "./chat-write-errors.js"
import { userContent } from "../transcript/user-content.js"
import { enqueueRunDelivery } from "./work-deliveries.js"
import {
  threadStep,
  type ThreadEvent,
  type ThreadLocation
} from "../focus-choices/thread-location.js"
import { messageTurnIdSql } from "./message-turns.js"
import { userChatSql } from "./chat-ownership.js"
import { sha256Hex } from "@arden-hq/std/hash"

interface FocusChoiceRow {
  readonly choice_id: string
  readonly question_id: string
  readonly source_session_id: string
  readonly space_id: string
  readonly revision: number
  readonly target_json: string
  readonly capture_policy_json: string
  readonly status: string
  readonly decision: string | null
  readonly result_session_id: string | null
  readonly result_session_ref: string | null
  readonly settlement_client_id: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly settled_at: string | null
  readonly target_session_id: string | null
}

const internalTargetSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("existing"),
    session_id: Schema.NonEmptyString,
    session_ref: Schema.NonEmptyString,
    label: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160))
  }),
  Schema.Struct({
    kind: Schema.Literal("create"),
    name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
    source_turn_id: Schema.NonEmptyString,
    purpose: Schema.optionalKey(Schema.NonEmptyString),
    starts_with: Schema.optionalKey(Schema.Array(Schema.String))
  })
])

const capturePolicySchema = Schema.Struct({
  origin: Schema.Literals(["chat", "automation", "task", "space", "unrecorded"] as const),
  task_item_id: Schema.NullOr(Schema.NonEmptyString),
  task_generation: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
})

export const matchesRecordedFocusTarget = (
  stored: string | null,
  requested: FocusQuestionTargetInput | undefined
): Effect.Effect<boolean, WorkStoreError> => {
  if (stored === null || requested === undefined) {
    return Effect.succeed(stored === null && requested === undefined)
  }
  return decodeJson(internalTargetSchema, stored).pipe(
    Effect.map(
      (target) =>
        target.kind === requested.kind &&
        (target.kind === "existing" && requested.kind === "existing"
          ? target.session_ref === requested.session_ref
          : target.kind === "create" &&
            requested.kind === "create" &&
            target.name === requested.name)
    ),
    Effect.mapError((cause) => workFailure("storage", "Stored Focus target is corrupt", cause))
  )
}

const failure = (
  reason: FocusChoiceStoreError["reason"],
  message: string,
  cause?: unknown
): FocusChoiceStoreError =>
  new FocusChoiceStoreError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const workFailure = (
  reason: WorkStoreError["reason"],
  message: string,
  cause?: unknown
): WorkStoreError =>
  new WorkStoreError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const readRow = Effect.fn("FocusChoice.readRow")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly spaceId: string
  readonly questionId: string
}) {
  const rows = yield* options.sql<FocusChoiceRow>`SELECT choice.*,
    result.public_ref AS result_session_ref
    FROM focus_choices AS choice
    LEFT JOIN sessions AS result ON result.session_id = choice.result_session_id
    WHERE choice.space_id = ${options.spaceId}
      AND choice.question_id = ${options.questionId}`
  const row = rows[0]
  if (row === undefined) return yield* failure("not_found", "Focus choice not found")
  return row
})

const project = Effect.fn("FocusChoice.project")(function* (
  row: FocusChoiceRow
): Effect.fn.Return<FocusChoice, FocusChoiceStoreError> {
  const storedTarget = yield* decodeJson(internalTargetSchema, row.target_json).pipe(
    Effect.mapError((cause) => failure("storage", "Stored Focus choice is corrupt", cause))
  )
  const target =
    storedTarget.kind === "existing"
      ? {
          kind: "existing" as const,
          session_ref: storedTarget.session_ref,
          label: storedTarget.label
        }
      : { kind: "create" as const, name: storedTarget.name }
  return yield* Schema.decodeUnknownEffect(FocusChoiceSchema)({
    choice_id: row.choice_id,
    question_id: row.question_id,
    source_session_id: row.source_session_id,
    space_id: row.space_id,
    revision: row.revision,
    target,
    status: row.status,
    decision: row.decision,
    result_session_ref: row.result_session_ref,
    created_at: row.created_at,
    updated_at: row.updated_at,
    settled_at: row.settled_at
  }).pipe(Effect.mapError((cause) => failure("storage", "Stored Focus choice is corrupt", cause)))
})

export const recordFocusChoiceInTransaction = Effect.fn("FocusChoice.recordInTransaction")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly questionId: string
    readonly runId: string
    readonly target: FocusQuestionTargetInput
    readonly now: string
  }): Effect.fn.Return<FocusChoice, WorkStoreError> {
    const sourceRows = yield* options.sql<{
      readonly source_session_id: string | null
      readonly space_id: string | null
      readonly turn_id: string | null
      readonly context_json: string
    }>`SELECT
    ${runDestinationSessionId(options.sql, runColumns(options.sql, "run"))} AS source_session_id,
    owner.space_id,
    json_extract(run.metadata_json, '$.turn_id') AS turn_id,
    json_extract(run.metadata_json, '$.run_context') AS context_json
    FROM chat_runs AS run
    LEFT JOIN sessions AS owner
      ON owner.session_id = ${runDestinationSessionId(options.sql, runColumns(options.sql, "run"))}
    JOIN spaces AS space ON space.space_id = owner.space_id
    WHERE run.run_id = ${options.runId}
      AND ${runMayActSql(options.sql, "run")}
      AND owner.archived_at IS NULL
      AND ${userChatSql("owner")}
      AND owner.parent_session_id IS NULL
      AND owner.parent_message_id IS NULL
      AND space.archived_at IS NULL
     `.pipe(
      Effect.mapError((cause) =>
        workFailure("storage", "Could not validate the Focus choice source", cause)
      )
    )
    const source = sourceRows[0]
    if (
      source?.source_session_id === null ||
      source?.source_session_id === undefined ||
      source.space_id === null ||
      source.turn_id === null
    ) {
      return yield* workFailure(
        "invalid",
        "Focus choices require an active conversation in the current Space"
      )
    }
    const context = yield* decodeJson(RunContextSchema, source.context_json).pipe(
      Effect.mapError((cause) =>
        workFailure("storage", "Focus choice Run context is corrupt", cause)
      )
    )
    let storedTarget: typeof internalTargetSchema.Type
    if (options.target.kind === "existing") {
      const targets = yield* options.sql<{
        readonly session_id: string
        readonly public_ref: string
        readonly name: string | null
      }>`SELECT session_id, public_ref, name FROM sessions
      WHERE public_ref = ${options.target.session_ref}
        AND space_id = ${source.space_id}
        AND session_id != ${source.source_session_id}
        AND archived_at IS NULL
        AND session_type = 'chat'
        AND parent_session_id IS NULL
        AND parent_message_id IS NULL
        AND origin_automation_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM space_conversations WHERE session_id = sessions.session_id
        )`.pipe(
        Effect.mapError((cause) =>
          workFailure("storage", "Could not validate the Focus target", cause)
        )
      )
      const target = targets[0]
      if (target === undefined) {
        return yield* workFailure(
          "invalid",
          "Focus target must be another active ordinary Chat in this Space. A chat on another Space takes a message instead (session_send_message)."
        )
      }
      storedTarget = {
        kind: "existing",
        session_id: target.session_id,
        session_ref: target.public_ref,
        label: target.name?.trim() || target.public_ref
      }
    } else {
      storedTarget = {
        kind: "create",
        name: options.target.name,
        source_turn_id: source.turn_id,
        ...(options.target.purpose === undefined ? {} : { purpose: options.target.purpose }),
        ...(options.target.starts_with === undefined
          ? {}
          : { starts_with: options.target.starts_with })
      }
    }
    const choiceId = `focus-choice:${sha256Hex(options.questionId)}`
    const capturePolicy = {
      origin: context.origin.kind,
      task_item_id: context.task?.item_id ?? null,
      task_generation: context.task?.generation ?? null
    }
    yield* Schema.decodeUnknownEffect(capturePolicySchema)(capturePolicy).pipe(
      Effect.mapError((cause) => workFailure("storage", "Focus policy capture failed", cause))
    )
    yield* options.sql`INSERT INTO focus_choices (
    choice_id, question_id, source_session_id, space_id, revision,
    target_json, capture_policy_json, status, decision, result_session_id,
    settlement_client_id, created_at, updated_at, settled_at
  ) VALUES (
    ${choiceId}, ${options.questionId}, ${source.source_session_id}, ${source.space_id}, 0,
    ${JSON.stringify(storedTarget)}, ${JSON.stringify(capturePolicy)}, 'offered', NULL, NULL,
    NULL, ${options.now}, ${options.now}, NULL
  )`.pipe(
      Effect.mapError((cause) => workFailure("storage", "Could not record the Focus choice", cause))
    )
    const row = yield* readRow({
      sql: options.sql,
      spaceId: source.space_id,
      questionId: options.questionId
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof FocusChoiceStoreError
          ? workFailure(cause.reason, cause.message, cause)
          : workFailure("storage", "Could not read the Focus choice", cause)
      )
    )
    return yield* project(row).pipe(
      Effect.mapError((error) => workFailure(error.reason, error.message, error))
    )
  }
)

const locationOf = (row: FocusChoiceRow): ThreadLocation => {
  if (row.status === "offered") return { kind: "waiting" }
  return row.decision === "open_target" ? { kind: "target" } : { kind: "source" }
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
    WHERE question.question_id = ${row.question_id} AND message.role = 'user'
      AND (json_extract(message.message_json, '$.is_meta') IS NOT 1
        OR json_type(message.message_json, '$.forwarded_from') = 'object')
    ORDER BY message.seq`
  for (const row of rows) {
    const stored: unknown = JSON.parse(row.message_json)
    if (!Predicate.isObject(stored)) continue
    if (stored.is_meta === true && !Schema.is(ChatForwardedSourceSchema)(stored.forwarded_from))
      continue
    return { messageId: row.message_id, text: userContent(stored.content).text }
  }
  return undefined
})

const applyThreadEventInTransaction = Effect.fn("FocusChoice.applyThreadEvent")(
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
    if (step.kind === "refused") return yield* failure("conflict", step.reason)
    if (step.kind === "unchanged") return step
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
    if (step.location === "target" && targetSessionId === null) {
      if (storedTarget.kind === "existing") {
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
    const owner = step.location === "target" ? targetSessionId : source.session_id
    if (owner === null) return yield* failure("storage", "The thread's target chat is missing")

    if (row.status === "offered") {
      yield* answerQuestionInTransaction({
        sql,
        questionId: row.question_id,
        clientId: options.clientId,
        answer: {
          kind: "choice",
          choice_id: step.location === "target" ? "open_target" : "continue_here"
        },
        now
      })
    }
    yield* sql`UPDATE focus_choices SET
      status = 'settled',
      decision = ${step.location === "target" ? "open_target" : "continue_here"},
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
    if (step.effects.forwardToTarget && targetSessionId !== null) {
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
    if (step.effects.answerSource) {
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

export const makeFocusChoiceStore = (options: {
  readonly writer: Writer
  readonly sessionEvents: SessionLifecycleEvents["Service"]
}): FocusChoiceStore["Service"] => {
  const { writer, sessionEvents } = options
  const sql = writer.sql
  const get: FocusChoiceStore["Service"]["get"] = (spaceId, questionId) =>
    readRow({ sql, spaceId, questionId }).pipe(
      Effect.flatMap(project),
      Effect.mapError((cause) =>
        cause instanceof FocusChoiceStoreError
          ? cause
          : failure("storage", "Could not read Focus choice", cause)
      )
    )

  const resolve: FocusChoiceStore["Service"]["resolve"] = Effect.fn("FocusChoice.resolve")(
    function* (spaceId, questionId, request) {
      const input = yield* Schema.decodeUnknownEffect(ResolveFocusChoiceInputSchema)(request, {
        onExcessProperty: "error"
      }).pipe(
        Effect.mapError((cause) => failure("invalid", "Invalid Focus choice decision", cause))
      )
      const now = DateTime.formatIso(yield* DateTime.now)
      return yield* writer.transact(
        Effect.gen(function* () {
          const row = yield* readRow({ sql, spaceId, questionId })
          const replay =
            row.status === "settled" &&
            row.settlement_client_id === input.client_id &&
            row.decision === input.decision
          if (!replay && row.status === "offered" && row.revision !== input.expected_revision) {
            return yield* failure("conflict", "This Focus choice changed; review it again")
          }
          if (!replay) {
            yield* applyThreadEventInTransaction({
              sql,
              sessionEvents,
              row,
              event: { kind: input.decision === "open_target" ? "choose_target" : "choose_here" },
              clientId: input.client_id,
              now
            })
          }
          const choice = yield* readRow({ sql, spaceId, questionId }).pipe(Effect.flatMap(project))
          if (choice.result_session_ref === null) {
            return yield* failure("conflict", "This Focus choice was already resolved differently")
          }
          if (choice.decision !== input.decision) {
            return yield* failure("conflict", "This Focus choice was already resolved differently")
          }
          const target = yield* decodeJson(internalTargetSchema, row.target_json).pipe(
            Effect.mapError((cause) => failure("storage", "Stored Focus choice is corrupt", cause))
          )
          return {
            choice,
            session_ref: choice.result_session_ref,
            created: input.decision === "open_target" && target.kind === "create"
          }
        })
      )
    },
    Effect.mapError((cause) =>
      cause instanceof FocusChoiceStoreError
        ? cause
        : failure("storage", "Could not resolve Focus choice", cause)
    )
  )

  const bringBack: FocusChoiceStore["Service"]["bringBack"] = Effect.fn("FocusChoice.bringBack")(
    function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now)
      return yield* writer.transact(
        Effect.gen(function* () {
          const rows =
            yield* sql<FocusChoiceRow>`SELECT choice.*, result.public_ref AS result_session_ref
          FROM focus_choices AS choice
          LEFT JOIN sessions AS result ON result.session_id = choice.result_session_id
          WHERE choice.question_id = ${input.threadId}
            AND choice.source_session_id = ${input.sessionId}`
          const row = rows[0]
          if (row === undefined) {
            return yield* failure("not_found", "No thread with that id moved from this chat")
          }
          yield* applyThreadEventInTransaction({
            sql,
            sessionEvents,
            row,
            event: { kind: "bring_back" },
            clientId: input.clientId,
            now
          })
        })
      )
    },
    Effect.mapError((cause) =>
      cause instanceof FocusChoiceStoreError
        ? cause
        : failure("storage", "Could not bring the thread back", cause)
    )
  )

  const threads: FocusChoiceStore["Service"]["threads"] = (sessionId) =>
    sql<{
      readonly question_id: string
      readonly target_json: string
      readonly decision: string
      readonly transition: string
      readonly transitioned_at: string
      readonly source_session_id: string
      readonly source_ref: string
      readonly source_name: string | null
      readonly target_ref: string
      readonly target_name: string | null
    }>`SELECT choice.question_id, choice.target_json, choice.decision, choice.transition,
      choice.transitioned_at, choice.source_session_id,
      source.public_ref AS source_ref, source.name AS source_name,
      target.public_ref AS target_ref, target.name AS target_name
    FROM focus_choices AS choice
    JOIN sessions AS source ON source.session_id = choice.source_session_id
    JOIN sessions AS target ON target.session_id = choice.target_session_id
    WHERE choice.status = 'settled' AND choice.transition IS NOT NULL
      AND (choice.decision = 'open_target' OR choice.transition = 'brought_back')
      AND (choice.source_session_id = ${sessionId} OR choice.target_session_id = ${sessionId})
    ORDER BY choice.transitioned_at DESC LIMIT 8`.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeJson(internalTargetSchema, row.target_json).pipe(
            Effect.map((target): ThreadRecord => ({
              threadId: row.question_id,
              name: target.kind === "existing" ? target.label : target.name,
              side: row.source_session_id === sessionId ? "source" : "target",
              location: row.decision === "open_target" ? "target" : "source",
              transition: row.transition === "brought_back" ? "brought_back" : "moved",
              at: row.transitioned_at,
              source: { ref: row.source_ref, name: row.source_name ?? "a chat" },
              target: { ref: row.target_ref, name: row.target_name ?? "a chat" }
            }))
          )
        )
      ),
      Effect.mapError((cause) => failure("storage", "Could not read thread locations", cause))
    )

  return FocusChoiceStore.of({ get, resolve, bringBack, threads })
}
