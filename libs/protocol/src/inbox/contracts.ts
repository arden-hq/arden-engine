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

export const INBOX_SPACE = { loose: "loose", space: "space" } as const

export type InboxSpace =
  | { readonly kind: "loose" }
  | { readonly kind: "space"; readonly space_id: string; readonly title: string }

export type InboxReadMark =
  | { readonly kind: "unmarked" }
  | { readonly kind: "marked"; readonly read_at: string }

export type InboxTaskNumbering =
  | { readonly kind: "unnumbered" }
  | { readonly kind: "numbered"; readonly seq: number }

export type InboxTaskAsk =
  | { readonly kind: "unasked" }
  | { readonly kind: "asked"; readonly text: string; readonly at: string }

export type InboxFailureRun =
  | { readonly kind: "unstarted" }
  | { readonly kind: "started"; readonly run_id: string }

export type InboxFailureOrigin =
  | { readonly kind: "workflow"; readonly workflow_ref: string; readonly run_id: string }
  | {
      readonly kind: "automation"
      readonly automation_task_id: string
      readonly run: InboxFailureRun
    }
  | { readonly kind: "task"; readonly run: InboxFailureRun }

export type InboxPlanLimitReached =
  | { readonly level: "used_up" }
  | { readonly level: "background" | "arden"; readonly limit_percent: number }

interface InboxItemBase extends JsonRecord {
  readonly key: string
  readonly group_key: string
  readonly at: string
  readonly counted: boolean
  readonly unread: boolean
  readonly read_mark: InboxReadMark
}

export interface InboxBlockedTaskItem extends InboxItemBase {
  readonly source: "blocked_task"
  readonly space: InboxSpace
  readonly item_id: string
  readonly stable_key: string
  readonly numbering: InboxTaskNumbering
  readonly text: string
  readonly waiting_on: InboxTaskWaitingOn
  readonly ask: InboxTaskAsk
}

export interface InboxApprovalItem extends InboxItemBase, RunApproval {
  readonly source: "approval"
}

export interface InboxFailureGroupItem extends InboxItemBase {
  readonly source: "failure"
  readonly space: InboxSpace
  readonly origin: InboxFailureOrigin
  readonly cause: string
  readonly run_count: number
  readonly first_at: string
  readonly last_at: string
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

export interface InboxPlanLimitItem extends InboxItemBase {
  readonly source: "plan_limit"
  readonly reached: InboxPlanLimitReached
  readonly used_percent: number
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

interface InboxGroupBase extends JsonRecord {
  readonly key: string
  readonly title: string
  readonly count: number
  readonly items: ReadonlyArray<InboxItem>
}

export interface InboxSpaceGroup extends InboxGroupBase {
  readonly kind: "space"
  readonly space: InboxSpace
}

export interface InboxSourceGroup extends InboxGroupBase {
  readonly kind: Exclude<InboxGroupKind, "space">
}

export type InboxGroup = InboxSpaceGroup | InboxSourceGroup

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
