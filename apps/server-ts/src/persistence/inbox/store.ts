import { storeErrorFields } from "../errors.js"
import type { RunApproval, RunQuestion } from "@arden-hq/protocol/runs"
import { Context, Effect, Schema } from "effect"

export class InboxStoreError extends Schema.TaggedError<InboxStoreError>()("InboxStoreError", {
  ...storeErrorFields({
    operations: ["view", "mark_read", "dismiss"],
    reasons: ["invalid", "not_found", "storage"]
  })
}) {}

interface InboxEntryBase {
  readonly key: string
  readonly groupKey: string
  readonly at: string
  readonly counted: boolean
  readonly unread: boolean
  readonly readAt: string | undefined
}

export interface InboxBlockedTaskEntry extends InboxEntryBase {
  readonly source: "blocked_task"
  readonly spaceId: string | null
  readonly spaceTitle: string | null
  readonly itemId: string
  readonly stableKey: string
  readonly seq: number | undefined
  readonly text: string
  readonly waitingOn: "you" | "external"
  readonly question: string | undefined
  readonly questionAt: string | undefined
}

export interface InboxApprovalEntry extends InboxEntryBase {
  readonly source: "approval"
  readonly approval: RunApproval
}

export interface InboxFailureEntry extends InboxEntryBase {
  readonly source: "failure"
  readonly spaceId: string | undefined
  readonly spaceTitle: string | undefined
  readonly automationTaskId: string | undefined
  readonly runId: string | undefined
  readonly workflowRef: string | undefined
  readonly cause: string
  readonly runCount: number
  readonly firstAt: string
  readonly lastAt: string
  readonly automationPaused: boolean
}

export interface InboxQuestionEntry extends InboxEntryBase {
  readonly source: "question"
  readonly question: RunQuestion
}

export interface InboxIncidentEntry extends InboxEntryBase {
  readonly source: "incident"
  readonly incidentId: string
  readonly code: "delivery.unroutable"
  readonly summary: string
  readonly deliveryId: string
  readonly sourceRunId: string
}

export interface InboxPlanLimitEntry extends InboxEntryBase {
  readonly source: "plan_limit"
  readonly level: "background" | "arden" | "used_up"
  readonly usedPercent: number
  readonly limitPercent: number | undefined
  readonly windowSeconds: number
  readonly resetsAt: string
}

export type InboxEntry =
  | InboxBlockedTaskEntry
  | InboxApprovalEntry
  | InboxFailureEntry
  | InboxQuestionEntry
  | InboxIncidentEntry
  | InboxPlanLimitEntry

export interface InboxEntryGroup {
  readonly key: string
  readonly kind: "space" | "questions" | "approvals" | "incidents" | "failures" | "limits"
  readonly title: string
  readonly spaceId: string | undefined
  readonly count: number
  readonly items: ReadonlyArray<InboxEntry>
}

export interface InboxState {
  readonly generatedAt: string
  readonly count: number
  readonly unreadCount: number
  readonly totalItems: number
  readonly truncated: boolean
  readonly groups: ReadonlyArray<InboxEntryGroup>
}

export type InboxReadScope =
  | { readonly scope: "all" }
  | { readonly scope: "items"; readonly keys: ReadonlyArray<string> }

export type InboxDismissScope =
  | { readonly scope: "all" }
  | { readonly scope: "group"; readonly groupKey: string }
  | { readonly scope: "items"; readonly keys: ReadonlyArray<string> }

export class InboxStore extends Context.Service<
  InboxStore,
  {
    readonly view: () => Effect.Effect<InboxState, InboxStoreError>
    readonly markRead: (scope: InboxReadScope) => Effect.Effect<InboxState, InboxStoreError>
    readonly dismiss: (scope: InboxDismissScope) => Effect.Effect<InboxState, InboxStoreError>
  }
>()("@arden-hq/server/persistence/inbox/InboxStore") {}
