import type { TodoListItem, TodoStatus } from "@arden-hq/protocol"
import {
  TODO_EXPLANATION,
  TODO_REASON,
  TODO_STATUS,
  type TodoExplanation,
  type TodoOverrideItemInput
} from "@arden-hq/protocol/sessions/todos"

export const isOpenTodo = (item: Pick<TodoListItem, "status">): boolean =>
  OPEN_STATUSES[item.status]

const OPEN_STATUSES: Record<TodoStatus, boolean> = {
  pending: true,
  in_progress: true,
  completed: false,
  cancelled: false
}

export const assignTodoIds = ({
  previous,
  next,
  newId
}: {
  readonly previous: ReadonlyArray<TodoListItem>
  readonly next: ReadonlyArray<TodoOverrideItemInput>
  readonly newId: () => string
}): ReadonlyArray<TodoListItem> => {
  const claimed = new Set<string>()
  return next.map((item) => {
    const match = previous.find(
      (earlier) => !claimed.has(earlier.id) && earlier.content.trim() === item.content.trim()
    )
    const id = match?.id ?? newId()
    claimed.add(id)
    return { ...item, id }
  })
}

export const statedReason = (item: TodoListItem): ReadonlyArray<string> =>
  item.status === TODO_STATUS.cancelled && item.reason.kind === TODO_REASON.stated
    ? [item.reason.text]
    : []

export const explanationText = (explanation: TodoExplanation): string | null =>
  explanation.kind === TODO_EXPLANATION.given ? explanation.text : null

export const explanationOf = (text: string | null): TodoExplanation =>
  text === null ? { kind: TODO_EXPLANATION.none } : { kind: TODO_EXPLANATION.given, text }

export interface FinishRecord {
  readonly item_id: string
  readonly list: boolean
  readonly open: number
  readonly cancelled: number
  readonly forced: boolean
  readonly closed: boolean
}

export const finishDecision = ({
  itemId,
  items,
  warned
}: {
  readonly itemId: string
  readonly items: ReadonlyArray<TodoListItem> | undefined
  readonly warned: boolean
}):
  | {
      readonly kind: "warn"
      readonly open: ReadonlyArray<TodoListItem>
      readonly record: FinishRecord
    }
  | { readonly kind: "close"; readonly record: FinishRecord } => {
  const open = (items ?? []).filter(isOpenTodo)
  const record = {
    item_id: itemId,
    list: items !== undefined,
    open: open.length,
    cancelled: (items ?? []).filter((item) => item.status === TODO_STATUS.cancelled).length
  }
  if (open.length > 0 && !warned)
    return { kind: "warn", open, record: { ...record, forced: false, closed: false } }
  return { kind: "close", record: { ...record, forced: open.length > 0, closed: true } }
}

export const planGaps = (items: ReadonlyArray<TodoListItem>): ReadonlyArray<string> =>
  items.flatMap((item) => {
    if (item.status === TODO_STATUS.cancelled)
      return [
        `${item.content} (cancelled${statedReason(item)
          .map((reason) => `: ${reason}`)
          .join("")})`
      ]
    return isOpenTodo(item) ? [`${item.content} (left open)`] : []
  })

export type OriginalRequest =
  | { readonly kind: "message"; readonly messageId: string; readonly text: string }
  | { readonly kind: "snapshot"; readonly text: string }
  | { readonly kind: "current"; readonly text: string }

export const originalRequest = (row: {
  readonly text: string
  readonly body: string | null
  readonly original_body: string | null
  readonly origin_message_id: string | null
  readonly origin_text: string | null
}): OriginalRequest => {
  if (row.origin_message_id !== null && row.origin_text !== null && row.origin_text.trim() !== "")
    return { kind: "message", messageId: row.origin_message_id, text: row.origin_text }
  if (row.original_body !== null) return { kind: "snapshot", text: row.original_body }
  return { kind: "current", text: taskWords(row) }
}

export const taskWords = (row: { readonly text: string; readonly body: string | null }): string =>
  row.body === null ? row.text : `${row.text}\n\n${row.body}`
