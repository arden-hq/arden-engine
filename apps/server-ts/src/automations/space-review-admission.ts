import { Schema } from "effect"
import type {
  SpaceReviewAdmission,
  SpaceReviewReads
} from "../persistence/automations/space-review.js"
import { UNFINISHED_TASK_STATUSES } from "../persistence/sqlite/task-status-sql.js"

export type ReviewChange = "chat_turn" | "memory_page" | "task" | "space_settings"

export type ReviewHold = "nothing" | "unfinished_tasks" | "open_offers"

const STARTS: Record<ReviewChange, Record<ReviewHold, boolean>> = {
  chat_turn: { nothing: true, unfinished_tasks: true, open_offers: true },
  space_settings: { nothing: true, unfinished_tasks: true, open_offers: true },
  memory_page: { nothing: false, unfinished_tasks: false, open_offers: false },
  task: { nothing: false, unfinished_tasks: true, open_offers: true }
}

export interface SpaceReviewVerdict {
  readonly admission: SpaceReviewAdmission
  readonly changes: ReadonlySet<ReviewChange>
  readonly holds: ReadonlySet<ReviewHold>
}

export interface ReviewState {
  readonly semantic: string
  readonly reads: SpaceReviewReads
}

export const spaceReviewAdmission = (
  current: ReviewState,
  reviewed: { readonly semantic: string } | undefined,
  asked: boolean
): SpaceReviewVerdict => {
  const now = rows(current.semantic)
  const before = reviewed === undefined ? undefined : rows(reviewed.semantic)
  const changes = new Set<ReviewChange>()
  if (current.reads.chats.length > 0) changes.add("chat_turn")
  if (current.reads.pages.length > 0 || current.reads.removed.length > 0) changes.add("memory_page")
  if (before === undefined || before.settings !== now.settings) changes.add("space_settings")
  if (before !== undefined && !sameTasks(before.tasks, now.tasks)) changes.add("task")
  const holds = new Set<ReviewHold>()
  if ([...now.tasks.values()].some((task) => task.unfinished)) holds.add("unfinished_tasks")
  if (current.reads.proposals.length > 0) holds.add("open_offers")
  if (holds.size === 0) holds.add("nothing")
  const starts = [...changes].some((change) => [...holds].some((hold) => STARTS[change][hold]))
  return { admission: verdictOf(asked || starts, changes.size), changes, holds }
}

const verdictOf = (starts: boolean, changes: number): SpaceReviewAdmission => {
  if (starts) return "changed"
  return changes === 0 ? "unchanged" : "nothing_to_act_on"
}

const SpaceRowSchema = Schema.fromJsonString(
  Schema.Struct({
    instructions: Schema.NullOr(Schema.String),
    inference_policy: Schema.Unknown
  })
)

const TaskRowSchema = Schema.fromJsonString(
  Schema.Struct({ item_id: Schema.String, status: Schema.String })
)

const SemanticSchema = Schema.fromJsonString(
  Schema.Struct({ space: Schema.String, tasks: Schema.Array(Schema.String) })
)

const UNFINISHED: ReadonlySet<string> = new Set(UNFINISHED_TASK_STATUSES)

const rows = (semantic: string) => {
  const decoded = Schema.decodeUnknownSync(SemanticSchema)(semantic)
  const space = Schema.decodeUnknownSync(SpaceRowSchema)(decoded.space)
  return {
    settings: JSON.stringify([space.instructions, space.inference_policy]),
    tasks: new Map(
      decoded.tasks.map((row) => {
        const task = Schema.decodeUnknownSync(TaskRowSchema)(row)
        return [task.item_id, { row, unfinished: UNFINISHED.has(task.status) }] as const
      })
    )
  }
}

const sameTasks = (
  before: ReadonlyMap<string, { readonly row: string }>,
  now: ReadonlyMap<string, { readonly row: string }>
): boolean =>
  before.size === now.size && [...now].every(([id, task]) => before.get(id)?.row === task.row)
