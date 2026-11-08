import { Effect, Schema } from "effect"
import {
  AuthorityHistoryError,
  AuthorityHistoryStore,
  HistoryWindowSchema,
  type HistoryPage,
  type HistoryWindow,
  type PermissionChange,
  type QuestionDecision,
  type ToolApprovalDecision
} from "../permissions/history.js"
import type { PersistenceDeps } from "./deps.js"

interface PermissionChangeRow {
  readonly change_id: number
  readonly permission_kind: "standing" | "command" | "override" | "rule"
  readonly permission_id: string | null
  readonly action: PermissionChange["action"]
  readonly principal: string | null
  readonly subject_kind: string | null
  readonly server_name: string | null
  readonly tool_name: string | null
  readonly argument_count: number | null
  readonly previous_mode: string | null
  readonly next_mode: string | null
  readonly source_question_id: string | null
  readonly source_session_id: string | null
  readonly source_run_id: string | null
  readonly source_tool_call_id: string | null
  readonly occurred_at: string | null
  readonly recorded_at: string
}

interface QuestionDecisionRow extends Omit<QuestionDecision, "choice_ids"> {
  readonly choice_ids_json: string | null
}

const permissionChange = (row: PermissionChangeRow): PermissionChange => {
  const source = {
    change_id: row.change_id,
    action: row.action,
    source_question_id: row.source_question_id,
    source_session_id: row.source_session_id,
    source_run_id: row.source_run_id,
    source_tool_call_id: row.source_tool_call_id,
    occurred_at: row.occurred_at,
    recorded_at: row.recorded_at
  }
  switch (row.permission_kind) {
    case "standing":
      if (row.permission_id === null || row.principal === null || row.tool_name === null)
        throw new Error("Stored standing permission history is incomplete")
      return {
        ...source,
        permission_kind: "standing",
        permission_id: row.permission_id,
        principal: row.principal,
        server_name: row.server_name,
        tool_name: row.tool_name
      }
    case "command":
      if (row.permission_id === null || row.argument_count === null)
        throw new Error("Stored command permission history is incomplete")
      return {
        ...source,
        permission_kind: "command",
        permission_id: row.permission_id,
        argument_count: row.argument_count
      }
    case "override":
      if (row.tool_name === null) throw new Error("Stored tool override history is incomplete")
      return {
        ...source,
        permission_kind: "override",
        tool_name: row.tool_name,
        previous_mode: row.previous_mode,
        next_mode: row.next_mode
      }
    case "rule":
      if (row.permission_id === null || row.principal === null || row.subject_kind === null)
        throw new Error("Stored permission rule history is incomplete")
      return {
        ...source,
        permission_kind: "rule",
        permission_id: row.permission_id,
        principal: row.principal,
        subject_kind: row.subject_kind,
        server_name: row.server_name,
        tool_name: row.tool_name,
        argument_count: row.argument_count,
        previous_mode: row.previous_mode,
        next_mode: row.next_mode
      }
  }
}

const windowOf = Effect.fn("AuthorityHistory.window")(function* (input: HistoryWindow) {
  return yield* Schema.decodeUnknownEffect(HistoryWindowSchema)(input, {
    onExcessProperty: "ignore"
  }).pipe(
    Effect.mapError(
      (cause) =>
        new AuthorityHistoryError({ reason: "invalid", message: "Invalid history window", cause })
    )
  )
})

const page = <T extends { readonly decision_id: number }>(
  rows: ReadonlyArray<T>,
  limit: number
): HistoryPage<T> => {
  const entries = rows.slice(0, limit)
  return {
    entries,
    next_after: rows.length > limit ? (entries.at(-1)?.decision_id ?? null) : null,
    coverage: "recorded-and-retired-legacy" as const
  }
}

export const makeAuthorityHistoryStore = ({
  writer,
  reader
}: Pick<PersistenceDeps, "writer" | "reader">): AuthorityHistoryStore["Service"] => {
  const permissionChanges = Effect.fn("AuthorityHistory.permissionChanges")(function* (
    input: HistoryWindow
  ) {
    const window = yield* windowOf(input)
    return yield* writer
      .snapshot(
        Effect.gen(function* () {
          const limit = window.limit ?? 50
          const rows = yield* reader<PermissionChangeRow>`
            SELECT * FROM permission_changes WHERE change_id > ${window.after ?? 0}
            ORDER BY change_id LIMIT ${limit + 1}`
          const entries = yield* Effect.try(() => rows.slice(0, limit).map(permissionChange))
          return {
            entries,
            next_after: rows.length > limit ? (entries.at(-1)?.change_id ?? null) : null,
            coverage: "migration-baseline-forward" as const
          }
        })
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthorityHistoryError({
              reason: "storage",
              message: "Could not read permission history",
              cause
            })
        )
      )
  })

  const questionDecisions = Effect.fn("AuthorityHistory.questionDecisions")(function* (
    input: HistoryWindow & { readonly questionId: string }
  ) {
    if (input.questionId.length === 0)
      return yield* new AuthorityHistoryError({
        reason: "invalid",
        message: "Question id is required"
      })
    const window = yield* windowOf(input)
    return yield* writer
      .snapshot(
        Effect.gen(function* () {
          const limit = window.limit ?? 50
          const rows = yield* reader<QuestionDecisionRow>`
            SELECT * FROM question_decisions
            WHERE question_id = ${input.questionId} AND decision_id > ${window.after ?? 0}
            ORDER BY decision_id LIMIT ${limit + 1}`
          const entries = yield* Effect.try(() =>
            rows.slice(0, limit).map(({ choice_ids_json, ...row }): QuestionDecision => ({
              ...row,
              choice_ids:
                choice_ids_json === null
                  ? null
                  : Schema.decodeUnknownSync(
                      Schema.fromJsonString(Schema.Array(Schema.NonEmptyString))
                    )(choice_ids_json)
            }))
          )
          return {
            entries,
            next_after: rows.length > limit ? (entries.at(-1)?.decision_id ?? null) : null,
            coverage: "recorded-and-retired-legacy" as const
          }
        })
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthorityHistoryError({
              reason: "storage",
              message: "Could not read question decisions",
              cause
            })
        )
      )
  })

  const toolApprovalDecisions = Effect.fn("AuthorityHistory.toolApprovalDecisions")(function* (
    input: HistoryWindow & { readonly runId: string; readonly toolCallId: string }
  ) {
    if (input.runId.length === 0 || input.toolCallId.length === 0)
      return yield* new AuthorityHistoryError({
        reason: "invalid",
        message: "Approval identity is required"
      })
    const window = yield* windowOf(input)
    return yield* writer
      .snapshot(
        Effect.gen(function* () {
          const limit = window.limit ?? 50
          const rows = yield* reader<ToolApprovalDecision>`
            SELECT * FROM tool_approval_decisions
            WHERE run_id = ${input.runId} AND tool_call_id = ${input.toolCallId}
              AND decision_id > ${window.after ?? 0}
            ORDER BY decision_id LIMIT ${limit + 1}`
          return page(rows, limit)
        })
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthorityHistoryError({
              reason: "storage",
              message: "Could not read approval decisions",
              cause
            })
        )
      )
  })

  return AuthorityHistoryStore.of({ permissionChanges, questionDecisions, toolApprovalDecisions })
}
