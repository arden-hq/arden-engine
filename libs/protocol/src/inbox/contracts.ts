import type { JsonRecord } from "../common/json.js"
import type { RunApproval } from "../runs/approvals.js"
import type { RunQuestion } from "../runs/questions.js"

/** Maximum number of items rendered and keys accepted by one read-mark request. */
export const INBOX_ITEM_LIMIT = 100

export type InboxGroupKind =
  | "space"
  | "questions"
  | "approvals"
  | "incidents"
  | "failures"
  | "limits"
export type InboxTaskWaitingOn = "you" | "external"

interface InboxItemBase extends JsonRecord {
  /** Stable identity used by the read-mark endpoint. */
  readonly key: string
  readonly group_key: string
  readonly at: string
  readonly counted: boolean
  readonly unread: boolean
  readonly read_at: string | null
}

export interface InboxBlockedTaskItem extends InboxItemBase {
  readonly source: "blocked_task"
  readonly space_id: string | null
  readonly space_title: string | null
  readonly item_id: string
  readonly stable_key: string
  readonly seq: number | null
  readonly text: string
  readonly waiting_on: InboxTaskWaitingOn
  readonly question: string | null
  readonly question_at: string | null
}

export interface InboxApprovalItem extends InboxItemBase, RunApproval {
  readonly source: "approval"
}

export interface InboxFailureGroupItem extends InboxItemBase {
  readonly source: "failure"
  readonly space_id: string | null
  readonly space_title: string | null
  readonly automation_task_id: string | null
  readonly run_id?: string | null
  /** Set when a Workflow's result never reached its Chat: that Workflow. */
  readonly workflow_ref?: string | null
  readonly cause: string
  readonly run_count: number
  readonly first_at: string
  readonly last_at: string
  /** The Automation paused itself after these failures (D-12): the row offers
   *  Resume, and it is one row for all of them. */
  readonly automation_paused: boolean
}

export interface InboxQuestionItem extends InboxItemBase {
  readonly source: "question"
  readonly question: RunQuestion
}

export interface InboxIncidentItem extends InboxItemBase {
  readonly source: "incident"
  readonly incident_id: string
  readonly code: "delivery.unroutable"
  readonly summary: string
  readonly delivery_id: string
  readonly source_run_id: string
}

/** The plan reached one of your limits. One notice per crossing: a new level
 *  or a new window is a new item, so reading or dismissing it holds until then. */
export interface InboxPlanLimitItem extends InboxItemBase {
  readonly source: "plan_limit"
  /** background: background work paused; arden: Arden stopped; used_up: the plan is used up. */
  readonly level: "background" | "arden" | "used_up"
  readonly used_percent: number
  /** The limit reached; null when the plan itself is used up. */
  readonly limit_percent: number | null
  readonly window_seconds: number
  readonly resets_at: string
}

export type InboxItem =
  | InboxBlockedTaskItem
  | InboxApprovalItem
  | InboxFailureGroupItem
  | InboxQuestionItem
  | InboxIncidentItem
  | InboxPlanLimitItem

export interface InboxGroup extends JsonRecord {
  readonly key: string
  readonly kind: InboxGroupKind
  readonly title: string
  readonly space_id: string | null
  readonly count: number
  readonly items: ReadonlyArray<InboxItem>
}

export interface InboxView extends JsonRecord {
  readonly generated_at: string
  readonly count: number
  readonly unread_count: number
  readonly total_items: number
  readonly truncated: boolean
  readonly groups: ReadonlyArray<InboxGroup>
}

export interface MarkAllInboxReadRequest {
  readonly scope: "all"
}

export interface MarkInboxItemsReadRequest {
  readonly scope: "items"
  readonly keys: ReadonlyArray<string>
}

export type MarkInboxReadRequest = MarkAllInboxReadRequest | MarkInboxItemsReadRequest

/** Dismissal hides named items from the Inbox without touching their source:
 *  the task stays blocked, the approval stays pending, the runs stay failed.
 *  An item returns on its own when its `at` moves past the dismissal — new
 *  activity resurfaces it, the way Linear and Slack re-notify a cleared row. */
export interface DismissAllInboxRequest {
  readonly scope: "all"
}

/** One group's worth, by the group key the view serves — items past the
 *  render cap included, which is why the client sends the group rather than
 *  the keys it happens to see. */
export interface DismissInboxGroupRequest {
  readonly scope: "group"
  readonly group_key: string
}

export interface DismissInboxItemsRequest {
  readonly scope: "items"
  readonly keys: ReadonlyArray<string>
}

export type DismissInboxRequest =
  | DismissAllInboxRequest
  | DismissInboxGroupRequest
  | DismissInboxItemsRequest
