import { type TaskSourceRecord } from "./task-record.js"

export const unsavedTaskRevision = (itemId: string): string => `${itemId}:0`

export interface TaskInferenceReview {
  readonly snapshot: string
  readonly tasks: ReadonlyArray<{
    readonly item_id: string
    readonly text: string
    readonly status: string
    readonly updated_at: string
  }>
  readonly chats: ReadonlyArray<{
    readonly session_id: string
    readonly session_ref: string
    readonly title: string | null
    readonly run_id: string | null
    readonly turn_id: string | null
    readonly status: string | null
    readonly owner_turn_id: string | null
    readonly pending: number
    readonly settled: boolean
  }>
  readonly proposals: ReadonlyArray<{
    readonly proposal_id: string
    readonly text: string
    readonly body: string | null
    readonly revision: number
    readonly status: string
    readonly sources: ReadonlyArray<TaskSourceRecord>
  }>
  readonly rejections: ReadonlyArray<{
    readonly kind: "proposal" | "expired" | "stopped_task"
    readonly item_id: string | null
    readonly proposal_id: string | null
    readonly sources: ReadonlyArray<TaskSourceRecord>
    readonly reason: string
  }>
}
