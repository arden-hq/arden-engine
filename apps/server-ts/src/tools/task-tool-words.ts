import type { TodoListItem } from "@arden-hq/protocol"
import { SPACE_TASK_RUNS_IN, TASK_STATUS } from "@arden-hq/protocol/spaces/work"
import { cutText } from "@arden-hq/std/text"
import type { TaskRecord } from "../persistence/work/task-record.js"
import type { TaskPatch } from "../persistence/work/task-patch.js"
import { TASK_EXECUTION_RECEIPT, type TaskExecutionReceipt } from "../persistence/work/store.js"
import { activityWords } from "../persistence/work/public.js"
import { ORIGINAL_REQUEST, type OriginalRequest } from "../persistence/todos/items.js"
import { taskHandle } from "./task-handle.js"
import type { ServerRunContext } from "./run-context.js"

export const namedLink = (label: string, url: string): string =>
  `[${label.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ")}](${url})`

export const taskUrl = (task: { readonly item_id: string }): string =>
  `arden:task/${encodeURIComponent(task.item_id)}`

interface TaskUpdateConfirmation {
  readonly result: string
  readonly preview: string
}

export const taskUpdateConfirmation = (
  task: { readonly item_id: string; readonly text: string },
  patch: TaskPatch
): TaskUpdateConfirmation => {
  const link = namedLink(task.text, taskUrl(task))
  if (patch.completion_result !== undefined) {
    return {
      result: [patch.completion_result, patch.completion_note, link]
        .filter((part): part is string => part !== undefined)
        .join("\n\n"),
      preview: "Task completed"
    }
  }
  if (patch.blocked === true)
    return { result: `${link} waits: ${patch.block_reason ?? ""}`, preview: "Task waiting" }
  if (patch.status === undefined) {
    return { result: `Saved changes to ${link}.`, preview: "Task changes saved" }
  }
  switch (patch.status) {
    case TASK_STATUS.cancelled:
      return {
        result: `Marked ${link} cancelled. Its other runs lose their authority and end at their next step.`,
        preview: "Task marked cancelled"
      }
    case TASK_STATUS.deferred:
      return {
        result: `Deferred ${link}. Any active run stops separately.`,
        preview: "Task deferred"
      }
    case TASK_STATUS.done:
      return {
        result: `Marked ${link} done. Its other runs lose their authority and end at their next step.`,
        preview: "Task marked done"
      }
    case TASK_STATUS.open:
      return { result: `Reopened ${link}.`, preview: "Task reopened" }
  }
}

export const executionWords = (receipt: TaskExecutionReceipt): string => {
  switch (receipt.kind) {
    case TASK_EXECUTION_RECEIPT.saved:
      return "Saved; execution has not started or been queued."
    case TASK_EXECUTION_RECEIPT.queued:
      return "Work queued; it has not started yet."
    case TASK_EXECUTION_RECEIPT.working:
      return "Working now."
    case TASK_EXECUTION_RECEIPT.scheduled:
      return `Next check scheduled for ${receipt.at}.`
    case TASK_EXECUTION_RECEIPT.inactive:
      return `Current state: ${receipt.state}.`
  }
}

const activityNote = (task: TaskRecord): string => {
  const words = task.status === TASK_STATUS.open ? activityWords(task) : undefined
  return words === undefined ? "" : `, ${words}`
}

export const taskState = (run: ServerRunContext, task: TaskRecord): string =>
  [
    `${namedLink(task.text, taskUrl(task))} (${taskHandle(run, task)})`,
    `Status: ${task.status}${task.blocked ? `, waiting on ${task.waiting_on ?? "you"}` : ""}${activityNote(task)}; runs in ${task.runs_in === SPACE_TASK_RUNS_IN.chat ? "its chat" : "the background"}; owner ${task.owner}.`,
    ...(task.token_budget === null ? [] : [`Token budget: ${task.token_budget}.`]),
    ...(task.next_attempt_at === null ? [] : [`Next check: ${task.next_attempt_at}.`]),
    ...(task.body === null ? [] : ["", task.body])
  ].join("\n")

const REQUEST_QUOTE_LIMIT = 2_000

export const finishWarning = (
  open: ReadonlyArray<TodoListItem>,
  request: OriginalRequest | undefined
): string =>
  [
    "Not finished: the Task is still open. Your todo list has open items:",
    ...open.map((item) => `- [${item.status}] ${item.content}`),
    ...(request === undefined ? [] : [requestLine(request)]),
    "Do them, or mark each cancelled with its reason in todo_update, then finish. Calling task_finish again in this run closes it as it stands, with the open items listed as still open."
  ].join("\n")

const requestLine = (request: OriginalRequest): string => {
  const text = cutText(request.text, REQUEST_QUOTE_LIMIT)
  switch (request.kind) {
    case ORIGINAL_REQUEST.message:
      return `The request (user message ${request.messageId}): ${JSON.stringify(text)}`
    case ORIGINAL_REQUEST.snapshot:
      return `The Task as first written: ${JSON.stringify(text)}`
    case ORIGINAL_REQUEST.current:
      return `The Task: ${JSON.stringify(text)}`
  }
}
