import type { JsonRecord } from "../common/json.js"
import type { RunApproval } from "../runs/approvals.js"
import type { RunQuestion } from "../runs/questions.js"
import type { SpaceTaskWaitingOn } from "../spaces/work/contracts.js"

export const INBOX_ITEM_LIMIT = 100

export type InboxGroupKind =
  | "space"
  | "questions"
  | "approvals"
  | "incidents"
  | "failures"
  | "limits"
export type InboxTaskWaitingOn = SpaceTaskWaitingOn

export const INBOX_SPACE = { loose: "loose", space: "space" } as const

export type InboxSpace =
  | { readonly kind: typeof INBOX_SPACE.loose }
  | { readonly kind: typeof INBOX_SPACE.space; readonly space_id: string; readonly title: string }

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

export const INBOX_PLAN_LIMIT_LEVEL = {
  background: "background",
  arden: "arden",
  used_up: "used_up"
} as const

export type InboxPlanLimitReached =
  | { readonly level: typeof INBOX_PLAN_LIMIT_LEVEL.used_up }
  | {
      readonly level: typeof INBOX_PLAN_LIMIT_LEVEL.background | typeof INBOX_PLAN_LIMIT_LEVEL.arden
      readonly limit_percent: number
    }

export const INBOX_ITEM_SOURCE = {
  blocked_task: "blocked_task",
  approval: "approval",
  failure: "failure",
  question: "question",
  incident: "incident",
  plan_limit: "plan_limit"
} as const

export type InboxItemSource = (typeof INBOX_ITEM_SOURCE)[keyof typeof INBOX_ITEM_SOURCE]

interface InboxItemBase extends JsonRecord {
  readonly key: string
  readonly group_key: string
  readonly at: string
  readonly counted: boolean
  readonly unread: boolean
  readonly read_mark: InboxReadMark
}

export interface InboxBlockedTaskItem extends InboxItemBase {
  readonly source: typeof INBOX_ITEM_SOURCE.blocked_task
  readonly space: InboxSpace
  readonly item_id: string
  readonly stable_key: string
  readonly numbering: InboxTaskNumbering
  readonly text: string
  readonly waiting_on: InboxTaskWaitingOn
  readonly ask: InboxTaskAsk
}

export interface InboxApprovalItem extends InboxItemBase, RunApproval {
  readonly source: typeof INBOX_ITEM_SOURCE.approval
}

export interface InboxFailureGroupItem extends InboxItemBase {
  readonly source: typeof INBOX_ITEM_SOURCE.failure
  readonly space: InboxSpace
  readonly origin: InboxFailureOrigin
  readonly cause: string
  readonly run_count: number
  readonly first_at: string
  readonly last_at: string
  readonly automation_paused: boolean
}

export interface InboxQuestionItem extends InboxItemBase {
  readonly source: typeof INBOX_ITEM_SOURCE.question
  readonly question: RunQuestion
}

export interface InboxIncidentItem extends InboxItemBase {
  readonly source: typeof INBOX_ITEM_SOURCE.incident
  readonly incident_id: string
  readonly code: "delivery.unroutable"
  readonly summary: string
  readonly delivery_id: string
  readonly source_run_id: string
}

export interface InboxPlanLimitItem extends InboxItemBase {
  readonly source: typeof INBOX_ITEM_SOURCE.plan_limit
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

export interface DismissAllInboxRequest {
  readonly scope: "all"
}

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
