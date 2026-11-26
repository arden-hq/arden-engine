import type { JsonRecord } from "../common/json.js"

export const STORAGE_CATEGORY = {
  chats: "chats",
  channels: "channels",
  agents: "agents",
  knowledge: "knowledge",
  skills: "skills",
  housekeeping: "housekeeping",
  other: "other"
} as const

export type StorageCategoryId = (typeof STORAGE_CATEGORY)[keyof typeof STORAGE_CATEGORY]

export interface StorageCategory extends JsonRecord {
  readonly id: StorageCategoryId
  readonly label: string
  readonly totalBytes: number
  readonly itemCount: number
  readonly description: string
  readonly detail: string
}

export const STORAGE_LIMIT = { unlimited: "unlimited", limited: "limited" } as const

export type StorageBudget =
  | { readonly kind: typeof STORAGE_LIMIT.unlimited }
  | {
      readonly kind: typeof STORAGE_LIMIT.limited
      readonly maxBytes: number
      readonly overBudgetBytes: number
    }

export interface StorageStatus extends JsonRecord {
  readonly totalBytes: number
  readonly budget: StorageBudget
  readonly checkedAt: string
  readonly categories: ReadonlyArray<StorageCategory>
}

export type StorageSpaceLimit =
  | { readonly kind: typeof STORAGE_LIMIT.unlimited }
  | { readonly kind: typeof STORAGE_LIMIT.limited; readonly gib: number }

export interface StorageSettings extends JsonRecord {
  readonly maxSpace: StorageSpaceLimit
  readonly allowArchivedSessionDeletion: boolean
  readonly allowInactiveSessionDeletion: boolean
  readonly inactiveSessionDays: number
  readonly minimumCurrentSessions: number
}

export type StorageSettingsPatch = StorageSettings

export const DEFAULT_STORAGE_SETTINGS: StorageSettings = Object.freeze({
  maxSpace: { kind: STORAGE_LIMIT.unlimited },
  allowArchivedSessionDeletion: false,
  allowInactiveSessionDeletion: false,
  inactiveSessionDays: 90,
  minimumCurrentSessions: 100
})

export const STORAGE_CURRENT_SESSION = { none: "none", session: "session" } as const

export type StorageCurrentSession =
  | { readonly kind: typeof STORAGE_CURRENT_SESSION.none }
  | { readonly kind: typeof STORAGE_CURRENT_SESSION.session; readonly sessionId: string }

export interface StorageCleanupContext {
  readonly currentSession: StorageCurrentSession
  readonly pinnedSessionIds: ReadonlyArray<string>
}

export interface StorageOverview extends JsonRecord {
  readonly status: StorageStatus
  readonly settings: StorageSettings
}

export const STORAGE_CLEANUP_ACTION = {
  delete_archived_session: "delete_archived_session",
  delete_inactive_session: "delete_inactive_session"
} as const

export type StorageCleanupActionKind =
  (typeof STORAGE_CLEANUP_ACTION)[keyof typeof STORAGE_CLEANUP_ACTION]

export interface StorageCleanupAction extends JsonRecord {
  readonly kind: StorageCleanupActionKind
  readonly resourceId: string
  readonly name: string
  readonly sizeBytes: number
  readonly agents: number
  readonly sideChats: number
  readonly description: string
}

export type StorageCleanupTarget =
  | { readonly kind: typeof STORAGE_LIMIT.unlimited }
  | {
      readonly kind: typeof STORAGE_LIMIT.limited
      readonly budgetBytes: number
      readonly targetBytes: number
    }

export interface StorageCleanupPlan extends JsonRecord {
  readonly beforeBytes: number
  readonly target: StorageCleanupTarget
  readonly estimatedAfterBytes: number
  readonly estimatedReclaimableBytes: number
  readonly attainable: boolean
  readonly actions: ReadonlyArray<StorageCleanupAction>
  readonly blockers: ReadonlyArray<string>
  readonly createdAt: string
}

export interface PreparedStorageCleanupPreview {
  readonly body: string
  readonly decode: (value: unknown) => StorageCleanupPlan
}

export interface StorageCleanupRun extends JsonRecord {
  readonly reclaimedBytes: number
  readonly actionsCompleted: number
  readonly overview: StorageOverview
}

export interface PreparedStorageCleanupRequest {
  readonly body: string
  readonly decode: (value: unknown) => StorageCleanupRun
}
