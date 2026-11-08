import type { JsonRecord } from "../../common/json.js"

export interface TodoOverrideItemInput {
  readonly content: string
  readonly status: TodoStatus
  readonly reason?: string
}

export interface SetTodoOverrideRequest {
  readonly items: ReadonlyArray<TodoOverrideItemInput>
  readonly explanation?: string | null
}

export interface TodoSnapshot extends JsonRecord {
  readonly items: ReadonlyArray<TodoListItem>
  readonly explanation: string | null
  readonly updated_at: string
}

export interface EffectiveSessionTodo extends TodoSnapshot {
  readonly edited: boolean
}

export type EffectiveSessionTodoResponse = EffectiveSessionTodo | null

export interface TodoLifecycleResponse extends JsonRecord {
  readonly status: "cleared" | "noop"
  readonly session_id: string
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export interface TodoListItem extends JsonRecord {
  /** Stable across list rewrites; absent on lists stored before ids. */
  readonly id?: string
  readonly content: string
  readonly status: TodoStatus
  /** Why a cancelled item was dropped. */
  readonly reason?: string
}
