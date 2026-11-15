import { Schema } from "effect"
import type {
  SpaceReviewAdmission,
  SpaceReviewReads
} from "../persistence/automations/space-review.js"
import { UNFINISHED_TASK_STATUSES } from "../persistence/sqlite/task-status-sql.js"

/**
 * What changed since the Space's last review, each read from one owner:
 * - `chat_turn`: an owner chat turn the review has not seen (`reads.chats`).
 * - `mail`: a routed mail or GitHub item new since the last review.
 * - `memory_page`: a page the review reads for this Space changed, or a source left it.
 *   Resident pages (`me.md`, `readme.md`, `profile.md`) are context for every Space, not this one's.
 *   It never starts a review; a page-only verdict is `nothing_to_act_on`.
 * - `task`: a Task of the Space was added, removed or changed in any field.
 * - `space_settings`: the Space instructions or inference policy changed, or there is no
 *   earlier review to compare with.
 */
export type ReviewChange = "chat_turn" | "mail" | "memory_page" | "task" | "space_settings"

/**
 * What the Space holds that a review can act on:
 * - `unfinished_tasks`: an open or deferred Task, which it may comment on or ask about.
 * - `open_offers`: an offered Task proposal, which it may revise or retire.
 * - `nothing`: neither; a review can then only offer new work.
 */
export type ReviewHold = "nothing" | "unfinished_tasks" | "open_offers"

/**
 * Whether a review starts for one change while the Space holds one thing. A review starts
 * when any cell it is in says so. With nothing held a review can only offer new work, and an
 * offer needs a chat turn, a mail item or new Space settings behind it: a page or Task change
 * alone gives it nothing to comment on, ask about or retire. A page change alone starts nothing
 * whatever the Space holds.
 */
const STARTS: Record<ReviewChange, Record<ReviewHold, boolean>> = {
  chat_turn: { nothing: true, unfinished_tasks: true, open_offers: true },
  mail: { nothing: true, unfinished_tasks: true, open_offers: true },
  space_settings: { nothing: true, unfinished_tasks: true, open_offers: true },
  memory_page: { nothing: false, unfinished_tasks: false, open_offers: false },
  task: { nothing: false, unfinished_tasks: true, open_offers: true }
}

export interface SpaceReviewVerdict {
  readonly admission: SpaceReviewAdmission
  readonly changes: ReadonlySet<ReviewChange>
  readonly holds: ReadonlySet<ReviewHold>
}

/** The part of a review input the check reads: the Space's rows and the changes against the checkpoint. */
export interface ReviewState {
  readonly semantic: string
  readonly reads: SpaceReviewReads
}

/**
 * The one admission check for a Space review, with no model call: start only when something
 * the review can act on changed since its last review, or when the owner asked for it
 * (a proposal recheck or a manual run).
 */
export const spaceReviewAdmission = (
  current: ReviewState,
  reviewed: { readonly semantic: string } | undefined,
  asked: boolean
): SpaceReviewVerdict => {
  const now = rows(current.semantic)
  const before = reviewed === undefined ? undefined : rows(reviewed.semantic)
  const changes = new Set<ReviewChange>()
  if (current.reads.chats.length > 0) changes.add("chat_turn")
  if (current.reads.items.some((item) => item.isNew)) changes.add("mail")
  if (
    current.reads.pages.some((page) => page.basis !== "resident") ||
    current.reads.removed.length > 0
  )
    changes.add("memory_page")
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

/** The Space's settings and Tasks from the input's `semantic` rows, in every shape it was stored in. */
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
