import { INBOX_SCOPE } from "@arden-hq/protocol/inbox"
import { type StoredRunQuestion } from "../runs/stored-question.js"
import { storeErrorFields } from "../errors.js"
import type { RunApproval } from "@arden-hq/protocol/runs"
import type {
  InboxFailureOrigin,
  InboxPlanLimitReached,
  InboxSpace,
  InboxTaskAsk,
  InboxTaskNumbering
} from "@arden-hq/protocol/inbox"
import { Context, Effect, Schema } from "effect"

export class InboxStoreError extends Schema.TaggedError<InboxStoreError>()("InboxStoreError", {
  ...storeErrorFields({
    operations: ["view", "open_asks", "mark_read", "dismiss"],
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
  readonly space: InboxSpace
  readonly itemId: string
  readonly stableKey: string
  readonly numbering: InboxTaskNumbering
  readonly text: string
  readonly waitingOn: "you" | "external"
  readonly ask: InboxTaskAsk
}

export interface InboxApprovalEntry extends InboxEntryBase {
  readonly source: "approval"
  readonly approval: RunApproval
}

export interface InboxFailureEntry extends InboxEntryBase {
  readonly source: "failure"
  readonly space: InboxSpace
  readonly origin: InboxFailureOrigin
  readonly cause: string
  readonly runCount: number
  readonly firstAt: string
  readonly lastAt: string
  readonly automationPaused: boolean
}

export interface InboxQuestionEntry extends InboxEntryBase {
  readonly source: "question"
  readonly question: StoredRunQuestion
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
  readonly reached: InboxPlanLimitReached
  readonly usedPercent: number
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

interface InboxEntryGroupBase {
  readonly key: string
  readonly title: string
  readonly count: number
  readonly items: ReadonlyArray<InboxEntry>
}

export type InboxEntryGroup =
  | (InboxEntryGroupBase & { readonly kind: "space"; readonly space: InboxSpace })
  | (InboxEntryGroupBase & {
      readonly kind: "questions" | "approvals" | "incidents" | "failures" | "limits"
    })

export interface InboxState {
  readonly generatedAt: string
  readonly count: number
  readonly unreadCount: number
  readonly totalItems: number
  readonly truncated: boolean
  readonly groups: ReadonlyArray<InboxEntryGroup>
}

export type InboxReadScope =
  | { readonly scope: typeof INBOX_SCOPE.all }
  | { readonly scope: typeof INBOX_SCOPE.items; readonly keys: ReadonlyArray<string> }

export type InboxDismissScope =
  | { readonly scope: typeof INBOX_SCOPE.all }
  | { readonly scope: typeof INBOX_SCOPE.group; readonly groupKey: string }
  | { readonly scope: typeof INBOX_SCOPE.items; readonly keys: ReadonlyArray<string> }

export interface OpenAsks {
  readonly questions: ReadonlyArray<StoredRunQuestion>
  readonly approvals: ReadonlyArray<RunApproval>
}

export class InboxStore extends Context.Service<
  InboxStore,
  {
    readonly view: () => Effect.Effect<InboxState, InboxStoreError>
    readonly openAsks: () => Effect.Effect<OpenAsks, InboxStoreError>
    readonly markRead: (scope: InboxReadScope) => Effect.Effect<InboxState, InboxStoreError>
    readonly dismiss: (scope: InboxDismissScope) => Effect.Effect<InboxState, InboxStoreError>
  }
>()("@arden-hq/server/persistence/inbox/InboxStore") {}
