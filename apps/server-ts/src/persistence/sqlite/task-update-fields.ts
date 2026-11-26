import { countOf } from "@arden-hq/std/count"
import { SPACE_TASK_OWNER, SPACE_TASK_RUNS_IN } from "@arden-hq/protocol/spaces/work"
import { Effect } from "effect"
import type { TaskPatch } from "../work/task-patch.js"
import type { TaskRecord } from "../work/task-record.js"
import type { WorkStoreError } from "../work/store.js"
import { workError } from "./work-records.js"

const describedTaskFields = [
  "text",
  "body",
  "status",
  "owner",
  "runs_in",
  "token_budget",
  "blocked",
  "waiting_on",
  "due_at"
] as const

const summarizedTaskFields = [...describedTaskFields, "next_attempt_at"] as const

const mutableTaskFields = [...summarizedTaskFields, "completed_at"] as const

const unscheduledTaskFields = [...describedTaskFields, "completed_at"] as const

export const normalizeBlockState = (
  current: Pick<TaskRecord, "blocked" | "waiting_on">,
  patch: TaskPatch
): Effect.Effect<Pick<TaskRecord, "blocked" | "waiting_on">, WorkStoreError> => {
  if (!Object.hasOwn(patch, "blocked") && !Object.hasOwn(patch, "waiting_on")) {
    return Effect.succeed({ blocked: current.blocked, waiting_on: current.waiting_on })
  }

  const blocked = patch.blocked ?? current.blocked
  if (!blocked) {
    if (
      Object.hasOwn(patch, "waiting_on") &&
      patch.waiting_on !== undefined &&
      patch.waiting_on !== null
    ) {
      return Effect.fail(workError("invalid", "waiting_on is only meaningful on a blocked task"))
    }
    return Effect.succeed({ blocked: false, waiting_on: null })
  }

  const waitingOn = Object.hasOwn(patch, "waiting_on") ? patch.waiting_on : current.waiting_on
  if (waitingOn === null || waitingOn === undefined) {
    return Effect.fail(workError("invalid", "a blocked task must say what it waits on"))
  }
  return Effect.succeed({ blocked: true, waiting_on: waitingOn })
}

export const taskChanged = (current: TaskRecord, next: TaskRecord): boolean =>
  mutableTaskFields.some((field) => current[field] !== next[field])

export const onlyScheduleChanged = (current: TaskRecord, next: TaskRecord): boolean =>
  unscheduledTaskFields.every((field) => current[field] === next[field])

type SummarizedTaskField = (typeof summarizedTaskFields)[number]

const changeWords: { readonly [Field in SummarizedTaskField]: (next: TaskRecord) => string } = {
  text: (next) => `Renamed Task to ${next.text}.`,
  body: () => "Task details updated.",
  status: (next) => `Status changed to ${next.status}.`,
  owner: (next) =>
    next.owner === SPACE_TASK_OWNER.worker ? "Assigned to Arden." : "Assigned to you.",
  runs_in: (next) =>
    next.runs_in === SPACE_TASK_RUNS_IN.chat
      ? "Arden works on it in its chat."
      : "Arden works on it in the background.",
  token_budget: (next) =>
    next.token_budget === null
      ? "Token budget removed."
      : `Token budget set to ${countOf(next.token_budget, "token")}.`,
  blocked: (next) => (next.blocked ? "Task blocked." : "Task unblocked."),
  waiting_on: (next) =>
    next.waiting_on === null ? "Waiting cleared." : `Waiting on ${next.waiting_on}.`,
  due_at: (next) =>
    next.due_at === null ? "Due date removed." : `Due date set to ${next.due_at}.`,
  next_attempt_at: (next) =>
    next.next_attempt_at === null
      ? "Next check removed."
      : `Next check scheduled for ${next.next_attempt_at}.`
}

export const taskChangeWords = (current: TaskRecord, next: TaskRecord): string =>
  summarizedTaskFields
    .filter((field) => current[field] !== next[field])
    .map((field) => changeWords[field](next))
    .join(" ")
