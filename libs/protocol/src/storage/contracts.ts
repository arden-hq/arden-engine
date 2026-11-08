import type { JsonRecord } from "../common/json.js"

export type StorageCategoryId =
  | "chats"
  | "channels"
  | "agents"
  | "knowledge"
  | "skills"
  | "housekeeping"
  | "other"

export interface StorageCategory extends JsonRecord {
  readonly id: StorageCategoryId
  readonly label: string
  readonly totalBytes: number
  readonly itemCount: number
  readonly description: string
  /** What the bucket holds right now, in the person's own terms ("92 current · 278 archived"). */
  readonly detail: string
}

export interface StorageStatus extends JsonRecord {
  readonly totalBytes: number
  readonly maxBytes: number | null
  readonly overBudgetBytes: number
  readonly checkedAt: string
  readonly categories: ReadonlyArray<StorageCategory>
}

export interface StorageSettings extends JsonRecord {
  readonly maxSpaceGiB: number | null
  readonly allowArchivedSessionDeletion: boolean
  readonly allowInactiveSessionDeletion: boolean
  readonly inactiveSessionDays: number
  readonly minimumCurrentSessions: number
}

export type StorageSettingsPatch = StorageSettings

/** The factory cleanup policy. The server seeds a fresh install from it and
 *  the Desktop's "Restore defaults" writes it back, so both read one source. */
export const DEFAULT_STORAGE_SETTINGS: StorageSettings = Object.freeze({
  maxSpaceGiB: null,
  allowArchivedSessionDeletion: false,
  allowInactiveSessionDeletion: false,
  inactiveSessionDays: 90,
  minimumCurrentSessions: 100
})

export interface StorageCleanupContext {
  readonly currentSessionId: string | null
  readonly pinnedSessionIds: ReadonlyArray<string>
}

export interface StorageOverview extends JsonRecord {
  readonly status: StorageStatus
  readonly settings: StorageSettings
}

export type StorageCleanupActionKind = "delete_archived_session" | "delete_inactive_session"

export interface StorageCleanupAction extends JsonRecord {
  readonly kind: StorageCleanupActionKind
  readonly resourceId: string
  readonly name: string
  readonly sizeBytes: number
  /** The sessions deleted with the chat: its agents and its Side chats. */
  readonly agents: number
  readonly sideChats: number
  readonly description: string
}

export interface StorageCleanupPlan extends JsonRecord {
  readonly beforeBytes: number
  readonly budgetBytes: number | null
  readonly targetBytes: number | null
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
