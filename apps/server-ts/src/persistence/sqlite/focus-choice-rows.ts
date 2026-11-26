import { FOCUS_CHOICE_TARGET } from "@arden-hq/protocol/sessions/focus-choices"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { FocusChoiceStoreError } from "../focus-choices/store.js"
import type { FocusQuestionTargetInput } from "../work/store.js"
import { WorkStoreError } from "../work/store.js"
import { decodeJson } from "./json.js"

export interface FocusChoiceRow {
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

export const internalTargetSchema = Schema.Union([
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

export const capturePolicySchema = Schema.Struct({
  origin: Schema.Literals(["chat", "automation", "task", "space", "unrecorded"] as const),
  task_item_id: Schema.NullOr(Schema.NonEmptyString),
  task_generation: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
})

export const matchesRecordedFocusTarget = (
  stored: string | null,
  requested: FocusQuestionTargetInput | undefined
): Effect.Effect<boolean, WorkStoreError> => {
  if (stored === null || requested === undefined)
    return Effect.succeed(stored === null && requested === undefined)
  return decodeJson(internalTargetSchema, stored).pipe(
    Effect.map(
      (target) =>
        target.kind === requested.kind &&
        (target.kind === FOCUS_CHOICE_TARGET.existing &&
        requested.kind === FOCUS_CHOICE_TARGET.existing
          ? target.session_ref === requested.session_ref
          : target.kind === FOCUS_CHOICE_TARGET.create &&
            requested.kind === FOCUS_CHOICE_TARGET.create &&
            target.name === requested.name)
    ),
    Effect.mapError((cause) => workFailure("storage", "Stored Focus target is corrupt", cause))
  )
}

export const failure = (
  reason: FocusChoiceStoreError["reason"],
  message: string,
  cause?: unknown
): FocusChoiceStoreError =>
  new FocusChoiceStoreError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

export const workFailure = (
  reason: WorkStoreError["reason"],
  message: string,
  cause?: unknown
): WorkStoreError =>
  new WorkStoreError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

export const readRow = Effect.fn("FocusChoice.readRow")(function* (options: {
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
