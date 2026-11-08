import { Context, Effect, Schema } from "effect"

export interface HistoryPage<T> {
  readonly entries: ReadonlyArray<T>
  readonly next_after: number | null
  readonly coverage: "migration-baseline-forward" | "recorded-and-retired-legacy"
}

export const HistoryWindowSchema = Schema.Struct({
  after: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })))
})

export interface HistoryWindow {
  readonly after?: number
  readonly limit?: number
}

interface PermissionChangeBase {
  readonly change_id: number
  readonly action: "baseline" | "granted" | "revoked" | "changed"
  readonly occurred_at: string | null
  readonly recorded_at: string
  readonly source_question_id: string | null
  readonly source_session_id: string | null
  readonly source_run_id: string | null
  readonly source_tool_call_id: string | null
}

export type PermissionChange =
  | (PermissionChangeBase & {
      readonly permission_kind: "standing"
      readonly permission_id: string
      readonly principal: string
      readonly server_name: string | null
      readonly tool_name: string
    })
  | (PermissionChangeBase & {
      readonly permission_kind: "command"
      readonly permission_id: string
      readonly argument_count: number
    })
  | (PermissionChangeBase & {
      readonly permission_kind: "override"
      readonly tool_name: string
      readonly previous_mode: string | null
      readonly next_mode: string | null
    })
  | (PermissionChangeBase & {
      readonly permission_kind: "rule"
      readonly permission_id: string
      readonly principal: string
      readonly subject_kind: string
      readonly server_name: string | null
      readonly tool_name: string | null
      readonly argument_count: number | null
      readonly previous_mode: string | null
      readonly next_mode: string | null
    })

export interface QuestionDecision {
  readonly decision_id: number
  readonly question_id: string
  readonly session_id: string
  readonly run_id: string
  readonly tool_call_id: string
  readonly kind: "answered" | "closed" | "baseline_answered" | "baseline_closed"
  readonly answer_kind: string | null
  readonly choice_id: string | null
  readonly choice_ids: ReadonlyArray<string> | null
  readonly occurred_at: string | null
  readonly recorded_at: string
}

export interface ToolApprovalDecision {
  readonly decision_id: number
  readonly run_id: string
  readonly tool_call_id: string
  readonly session_id: string
  readonly tool_name: string
  readonly kind: "resolved" | "baseline"
  readonly status: "approved" | "rejected"
  readonly requested_at: string
  readonly resolved_at: string
  readonly recorded_at: string
}

export class AuthorityHistoryError extends Schema.TaggedError<AuthorityHistoryError>()(
  "AuthorityHistoryError",
  {
    reason: Schema.Literals(["invalid", "storage"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class AuthorityHistoryStore extends Context.Service<
  AuthorityHistoryStore,
  {
    readonly permissionChanges: (
      input: HistoryWindow
    ) => Effect.Effect<HistoryPage<PermissionChange>, AuthorityHistoryError>
    readonly questionDecisions: (
      input: HistoryWindow & { readonly questionId: string }
    ) => Effect.Effect<HistoryPage<QuestionDecision>, AuthorityHistoryError>
    readonly toolApprovalDecisions: (
      input: HistoryWindow & { readonly runId: string; readonly toolCallId: string }
    ) => Effect.Effect<HistoryPage<ToolApprovalDecision>, AuthorityHistoryError>
  }
>()("@arden-hq/server/persistence/permissions/AuthorityHistoryStore") {}
