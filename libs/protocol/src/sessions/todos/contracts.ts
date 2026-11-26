import type { JsonRecord } from "../../common/json.js"

export const TODO_STATUS = {
  pending: "pending",
  in_progress: "in_progress",
  completed: "completed",
  cancelled: "cancelled"
} as const

export const TODO_REASON = { unstated: "unstated", stated: "stated" } as const

export const TODO_EXPLANATION = { none: "none", given: "given" } as const

export const SESSION_TODO = { none: "none", list: "list" } as const

export type TodoStatus = (typeof TODO_STATUS)[keyof typeof TODO_STATUS]

export type PlannedTodoStatus = Exclude<TodoStatus, typeof TODO_STATUS.cancelled>

export type TodoCancelReason =
  | { readonly kind: typeof TODO_REASON.unstated }
  | { readonly kind: typeof TODO_REASON.stated; readonly text: string }

export type TodoExplanation =
  | { readonly kind: typeof TODO_EXPLANATION.none }
  | { readonly kind: typeof TODO_EXPLANATION.given; readonly text: string }

export interface PlannedTodoInput {
  readonly content: string
  readonly status: PlannedTodoStatus
}

export interface CancelledTodoInput {
  readonly content: string
  readonly status: typeof TODO_STATUS.cancelled
  readonly reason: TodoCancelReason
}

export type TodoOverrideItemInput = PlannedTodoInput | CancelledTodoInput

export interface SetTodoOverrideRequest {
  readonly items: ReadonlyArray<TodoOverrideItemInput>
  readonly explanation: TodoExplanation
}

export interface TodoSnapshot extends JsonRecord {
  readonly items: ReadonlyArray<TodoListItem>
  readonly explanation: TodoExplanation
  readonly updated_at: string
}

export interface EffectiveSessionTodo extends TodoSnapshot {
  readonly edited: boolean
}

export type EffectiveSessionTodoResponse =
  | { readonly kind: typeof SESSION_TODO.none }
  | ({ readonly kind: typeof SESSION_TODO.list } & EffectiveSessionTodo)

export interface TodoLifecycleResponse extends JsonRecord {
  readonly status: "cleared" | "noop"
  readonly session_id: string
}

export interface PlannedTodoItem extends JsonRecord {
  readonly id: string
  readonly content: string
  readonly status: PlannedTodoStatus
}

export interface CancelledTodoItem extends JsonRecord {
  readonly id: string
  readonly content: string
  readonly status: typeof TODO_STATUS.cancelled
  readonly reason: TodoCancelReason
}

export type TodoListItem = PlannedTodoItem | CancelledTodoItem
