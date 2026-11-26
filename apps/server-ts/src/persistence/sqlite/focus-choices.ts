import { RunContextSchema } from "../runs/stored-context.js"
import { FOCUS_CHOICE_STATUS, type FocusChoice } from "@arden-hq/protocol/sessions/focus-choices"
import {
  FocusChoiceSchema,
  ResolveFocusChoiceInputSchema
} from "@arden-hq/protocol/effect/sessions/focus-choices"
import { DateTime, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import {
  FocusChoiceStore,
  FocusChoiceStoreError,
  type ThreadRecord
} from "../focus-choices/store.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import type { FocusQuestionTargetInput } from "../work/store.js"
import { WorkStoreError } from "../work/store.js"
import { runColumns, runDestinationSessionId } from "./run-destination.js"
import { decodeJson } from "./json.js"
import type { Writer } from "./deps.js"
import { runMayActSql } from "./run-liveness.js"
import { userChatSql } from "./chat-ownership.js"
import { sha256Hex } from "@arden-hq/std/hash"
import {
  type FocusChoiceRow,
  capturePolicySchema,
  failure,
  internalTargetSchema,
  readRow,
  workFailure
} from "./focus-choice-rows.js"
import { applyThreadEventInTransaction } from "./focus-thread-events.js"

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
  const { decision, result_session_ref, settled_at } = row
  const settled = row.status === FOCUS_CHOICE_STATUS.settled
  return yield* Schema.decodeUnknownEffect(FocusChoiceSchema)({
    choice_id: row.choice_id,
    question_id: row.question_id,
    source_session_id: row.source_session_id,
    space_id: row.space_id,
    revision: row.revision,
    target,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(settled ? { decision, result_session_ref, settled_at } : {})
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
          if (choice.status === FOCUS_CHOICE_STATUS.offered || choice.decision !== input.decision) {
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
