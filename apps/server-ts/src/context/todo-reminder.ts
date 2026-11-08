import type { ChatMessage } from "@arden-hq/loop"
import type { EffectiveSessionTodoResponse } from "@arden-hq/protocol/sessions/todos"
import { isOpenTodo } from "../persistence/todos/items.js"

export const TODO_REMINDER_SOURCE = "todo_reminder"

const TODO_REMINDER_TURNS = 10

export const todoReminderDue = (messages: ReadonlyArray<ChatMessage>): boolean => {
  let turns = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (message.role === "developer" && message.arden_context_source === TODO_REMINDER_SOURCE)
      return false
    if (message.role !== "assistant") continue
    if ((message.tool_calls ?? []).some((call) => call.function.name === "todo_update"))
      return false
    turns += 1
    if (turns >= TODO_REMINDER_TURNS) return true
  }
  return true
}

export const renderTodoReminder = (todo: EffectiveSessionTodoResponse): string | undefined => {
  if (todo === null || todo.edited || !todo.items.some(isOpenTodo)) return undefined
  return [
    "Your todo list in this chat still has open items. Keep it current with todo_update: mark items completed as you finish them, or cancelled with a reason. Do not mention this reminder.",
    ...todo.items.map(
      (item) =>
        `- [${item.status}] ${item.content}${item.reason === undefined ? "" : ` (${item.reason})`}`
    )
  ].join("\n")
}
