import type { ApprovalPresentation } from "./approval-presentation.js"
import type { JsonRecord } from "../common/json.js"
import type { RunApprovalWork } from "../runs/context.js"
import type { RuleSavedIn } from "../runs/questions.js"

export interface RuntimeApprovalSnapshot extends JsonRecord {
  readonly tool_id: string
  /** The durable owner of this card's decision. Older snapshots omit it. */
  readonly source?: "run" | "deferred"
  readonly tool_name: string
  readonly preview?: string | null
  readonly diff?: string | null
  readonly status: "pending"
  readonly requested_at?: string | null
  readonly run_id?: string | null
  readonly session_id?: string | null
  readonly action?: string | null
  readonly scope?: string | null
  readonly expires_at?: string | null
  readonly description?: string | null
  /** Where the card's "Always allow" saves a rule: the run's own list, then
   *  everywhere, each only while a tap there would save. Absent when none can. */
  readonly rule_places?: ReadonlyArray<RuleSavedIn>
  readonly can_attach_folder_to_space?: boolean
  /** The folder those choices keep, written for the card. */
  readonly grant_folder?: string
  readonly parent_session_id?: string | null
  readonly presentation?: ApprovalPresentation | null
  /** The Task or Automation the asking run works for, on a card from another chat. */
  readonly work?: RunApprovalWork
}

export interface RuntimeConnectionSnapshot extends JsonRecord {
  readonly tool_id: string
  readonly run_id: string
  readonly session_id?: string
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
  readonly decision_delivery?: "blocking" | "deferred"
  readonly account_ref?: string | null
}

export interface ActiveRunSnapshot extends JsonRecord {
  readonly run_id: string
  readonly turn_id: string
  readonly status: RuntimeRunStatus | string
  readonly started_at?: string | null
  readonly updated_at?: string | null
  readonly ended_at?: string | null
  readonly stop_reason?: string | null
  readonly checkpoint_seq: number
  readonly latest_event_seq: number
  readonly error_code?: string | null
  readonly error_message?: string | null
  readonly pending_approvals: ReadonlyArray<RuntimeApprovalSnapshot>
  readonly pending_connections: ReadonlyArray<RuntimeConnectionSnapshot>
  /**
   * Calls of this run held before their effect began (a journaled
   * TOOL_CALL_WAITING with no later start or result). Absent from older servers.
   */
  readonly waiting_tool_call_ids?: ReadonlyArray<string>
}

export interface SessionRuntimeSnapshot extends JsonRecord {
  readonly session_id: string | null
  readonly latest_event_seq: number
  readonly checkpoint_seq: number
  readonly active_run: ActiveRunSnapshot | null
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
