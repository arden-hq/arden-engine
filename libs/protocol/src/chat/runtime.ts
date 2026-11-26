import type { ApprovalPresentation } from "./approval-presentation.js"
import type { JsonRecord } from "../common/json.js"
import type { RunApprovalWork } from "../runs/context.js"
import type { RuleSavedIn } from "../runs/questions.js"

export const APPROVAL_GRANT_FOLDER = { none: "none", folder: "folder" } as const

export type ApprovalGrantFolder =
  | { readonly kind: typeof APPROVAL_GRANT_FOLDER.none }
  | { readonly kind: typeof APPROVAL_GRANT_FOLDER.folder; readonly folder: string }

export const APPROVAL_ASKER = { chat: "chat", work: "work" } as const

export type ApprovalAsker =
  | { readonly kind: typeof APPROVAL_ASKER.chat }
  | { readonly kind: typeof APPROVAL_ASKER.work; readonly work: RunApprovalWork }

export const APPROVAL_PREVIEW = { none: "no_preview", preview: "preview" } as const

export type ApprovalPreview =
  | { readonly kind: typeof APPROVAL_PREVIEW.none }
  | { readonly kind: typeof APPROVAL_PREVIEW.preview; readonly text: string }

export const APPROVAL_DIFF = { none: "no_diff", diff: "diff" } as const

export type ApprovalDiff =
  | { readonly kind: typeof APPROVAL_DIFF.none }
  | { readonly kind: typeof APPROVAL_DIFF.diff; readonly patch: string }

export const APPROVAL_CARD = { plain: "plain", presented: "presented" } as const

export type ApprovalCard =
  | { readonly kind: typeof APPROVAL_CARD.plain }
  | { readonly kind: typeof APPROVAL_CARD.presented; readonly presentation: ApprovalPresentation }

export interface RuntimeApprovalSnapshot extends JsonRecord {
  readonly tool_id: string
  readonly source: "run" | "deferred"
  readonly tool_name: string
  readonly preview: ApprovalPreview
  readonly diff: ApprovalDiff
  readonly status: "pending"
  readonly requested_at: string
  readonly run_id: string
  readonly session_id: string
  readonly action: string
  readonly rule_places: ReadonlyArray<RuleSavedIn>
  readonly can_attach_folder_to_space: boolean
  readonly grant_folder: ApprovalGrantFolder
  readonly card: ApprovalCard
  readonly asker: ApprovalAsker
}

export const CONNECTION_ACCOUNT = { default: "default", account: "account" } as const

export type ConnectionAccount =
  | { readonly kind: typeof CONNECTION_ACCOUNT.default }
  | { readonly kind: typeof CONNECTION_ACCOUNT.account; readonly ref: string }

export interface RuntimeConnectionSnapshot extends JsonRecord {
  readonly tool_id: string
  readonly run_id: string
  readonly session_id: string
  readonly integration_id: string
  readonly connection_id: string
  readonly label: string
  readonly reason: ConnectionState
  readonly detail: string
  readonly capability: string
  readonly action: ConnectionAction
  readonly settings_tab: string
  readonly required_scopes: ReadonlyArray<string>
  readonly source: "recovery" | "suggestion"
  readonly decision_delivery: "blocking" | "deferred"
  readonly account: ConnectionAccount
}

export interface ActiveRunSnapshot extends JsonRecord {
  readonly run_id: string
  readonly turn_id: string
  readonly status: RuntimeRunStatus | string
  readonly started_at: string
  readonly updated_at: string
  readonly checkpoint_seq: number
  readonly latest_event_seq: number
  readonly pending_approvals: ReadonlyArray<RuntimeApprovalSnapshot>
  readonly pending_connections: ReadonlyArray<RuntimeConnectionSnapshot>
  readonly waiting_tool_call_ids: ReadonlyArray<string>
}

export const RUNTIME_RUN = { idle: "idle", active: "active" } as const

export type RuntimeRun =
  | { readonly kind: typeof RUNTIME_RUN.idle }
  | { readonly kind: typeof RUNTIME_RUN.active; readonly run: ActiveRunSnapshot }

export interface SessionRuntimeSnapshot extends JsonRecord {
  readonly session_id: string
  readonly latest_event_seq: number
  readonly checkpoint_seq: number
  readonly active_run: RuntimeRun
  /**
   * Work that still owns the Session context, by the same predicates that make
   * the server refuse an edit or a clear. Wider than `active_run`: a stale
   * pending run under a newer settled one, a live Workflow, or a tool still out
   * are all invisible to `active_run` yet all block the mutation.
   */
  readonly blocking_work: boolean
  readonly pending_approvals: ReadonlyArray<RuntimeApprovalSnapshot>
  readonly pending_connections: ReadonlyArray<RuntimeConnectionSnapshot>
}

/**
 * The Run statuses the code writes. The `chat_runs` CHECK still also allows
 * `backgrounded` and `failed` on purpose: nothing writes them (migration 0138
 * turned old `failed` rows into `error`), and dropping them from the CHECK
 * means rewriting the large table, which would break the migration time limit.
 */
export type RuntimeRunStatus =
  | "pending"
  | "running"
  | "interrupted"
  | "error"
  | "cancelled"
  | "completed"

export type ConnectionState =
  | "not_configured"
  | "disabled"
  | "auth_required"
  | "scope_required"
  | "degraded"

export type ConnectionAction = "oauth" | "credentials" | "enable" | "settings"
