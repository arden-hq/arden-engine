import { isTaskUnfinished, taskActivityWords, type SpaceTask } from "@arden-hq/protocol/spaces/work"
import { Schema } from "effect"
import { PROMPT_TEXT } from "../prompts/catalog.js"
import { sha256Base64Url } from "@arden-hq/std/hash"
import { clipLine, cutText } from "@arden-hq/std/text"

export interface SpaceView {
  readonly space_id: string
  readonly name: string
  readonly instructions: string | undefined
  readonly isConversation: boolean
  readonly conversation?: SpaceChatView | undefined
  readonly chats: ReadonlyArray<SpaceChatView>
  readonly page: { readonly path: string; readonly content: string } | undefined
  readonly questions: ReadonlyArray<SpaceQuestionView>
  readonly tasks: ReadonlyArray<SpaceTaskView>
}

interface SpaceChatView {
  readonly session_id: string
  readonly session_ref: string | undefined
  readonly name: string
  readonly summary: string | undefined
}

interface SpaceQuestionView {
  readonly question_id: string
  readonly prompt: string
  readonly detail: string | undefined
  readonly choices: ReadonlyArray<string>
  readonly task: string | undefined
}

type SpaceTaskView = Pick<
  SpaceTask,
  | "item_id"
  | "stable_key"
  | "text"
  | "status"
  | "owner"
  | "activity"
  | "waiting_on"
  | "stop_reason"
  | "next_attempt_at"
>

const SPACE_CONTEXT_MAX_BYTES = 10_000
const SPACE_PAGE_MAX_BYTES = 4_000
const SPACE_CHANGES_MAX_BYTES = 4_000
const SETTLED_TASKS_SHOWN = 15
const TRACKED_SETTLED_TASKS = 30
const TRACKED_CHATS = 50
const MORE_LINE_BYTES = 120

const encoder = new TextEncoder()
const byteLength = (value: string): number => encoder.encode(value).byteLength

export const renderSpaceContext = (
  view: SpaceView,
  { maxBytes = SPACE_CONTEXT_MAX_BYTES }: { readonly maxBytes?: number } = {}
): { readonly text: string; readonly pageWhole: boolean } => {
  const head = [
    "## Current Space",
    "",
    `Space "${view.name}" (space_id ${view.space_id}). ${
      view.isConversation
        ? "This chat is the Space's own conversation."
        : "This chat is one of the Space's chats, not its own conversation."
    }`,
    ...(view.isConversation || view.conversation === undefined
      ? []
      : [`The Space's own conversation: ${chatLine(view.conversation).slice(2)}`]),
    ...(view.instructions === undefined
      ? []
      : ["", "Space instructions:", cutText(view.instructions, 4_000)])
  ].join("\n")
  const navigation = PROMPT_TEXT.spaceNavigation
  let remaining = maxBytes - byteLength(head) - byteLength(navigation) - 4
  const blocks: Array<string> = []
  const place = (block: string | undefined): void => {
    if (block === undefined) return
    blocks.push(block)
    remaining -= byteLength(block) + 2
  }
  const tasks = rankedTasks(view.tasks)
  const open = tasks.filter((task) => isTaskUnfinished(task.status))
  const settled = tasks
    .filter((task) => !isTaskUnfinished(task.status))
    .slice(0, SETTLED_TASKS_SHOWN)
  place(
    fitList({
      title: `Open questions (${view.questions.length}):`,
      lines: view.questions.map(questionLine),
      more: (count) => `+${count} more open questions — use space_board_read`,
      budget: remaining
    })
  )
  place(
    fitList({
      title: `Tasks (${open.length} open, ${tasks.length - open.length} settled):`,
      lines: [...open, ...settled].map(taskLine),
      more: (count) =>
        `+${count + tasks.length - open.length - settled.length} more Tasks — use space_board_read`,
      budget: remaining,
      hidden: tasks.length - open.length - settled.length
    })
  )
  place(
    fitList({
      title: `Other chats in this Space (${view.chats.length}):`,
      lines: view.chats.map(chatLine),
      more: (count) => `+${count} more chats — use session_list`,
      budget: remaining
    })
  )
  const page =
    view.page === undefined
      ? undefined
      : pageBlock(view.page, Math.min(remaining, SPACE_PAGE_MAX_BYTES))
  place(page?.text)
  return {
    text: [head, ...blocks, navigation].join("\n\n"),
    pageWhole: page?.whole === true && view.page?.content !== ""
  }
}

export const SpaceFactsSchema = Schema.Struct({
  name: Schema.String,
  instructions: Schema.String,
  chats: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, summary: Schema.String })
  ),
  page: Schema.optionalKey(Schema.Struct({ path: Schema.String, content: Schema.String })),
  questions: Schema.Array(Schema.Struct({ id: Schema.String, prompt: Schema.String })),
  tasks: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      status: Schema.Literals(["open", "deferred", "done", "cancelled"]),
      state: Schema.String
    })
  )
})
export type SpaceFacts = typeof SpaceFactsSchema.Type

export const spaceFacts = (view: SpaceView): SpaceFacts => ({
  name: view.name,
  instructions: digest(view.instructions ?? ""),
  chats: view.chats.slice(0, TRACKED_CHATS).map((chat) => ({
    id: chat.session_id,
    name: chat.name,
    summary: digest(chat.summary ?? "")
  })),
  ...(view.page === undefined
    ? {}
    : { page: { path: view.page.path, content: digest(view.page.content) } }),
  questions: view.questions.map((question) => ({
    id: question.question_id,
    prompt: cutText(question.prompt, 200)
  })),
  tasks: [
    ...view.tasks.filter((task) => isTaskUnfinished(task.status)),
    ...view.tasks.filter((task) => !isTaskUnfinished(task.status)).slice(0, TRACKED_SETTLED_TASKS)
  ].map((task) => ({
    id: task.item_id,
    title: taskTitle(task),
    status: task.status,
    state: stateWords(task).join(" · ")
  }))
})

export const renderSpaceChanges = (
  previous: SpaceFacts,
  view: SpaceView,
  { maxBytes = SPACE_CHANGES_MAX_BYTES }: { readonly maxBytes?: number } = {}
): string | undefined => {
  const current = spaceFacts(view)
  const lines = [
    ...(previous.name === current.name ? [] : [`- This Space is now named "${view.name}".`]),
    ...questionChanges(previous, view),
    ...taskChanges(previous, current, view),
    ...chatChanges(previous, current, view)
  ]
  const blocks = [
    ...(previous.instructions === current.instructions
      ? []
      : [
          view.instructions === undefined
            ? "The Space no longer has instructions."
            : `The Space instructions changed; they now read:\n${cutText(view.instructions, 4_000)}`
        ]),
    ...pageChange(previous, current, view)
  ]
  if (lines.length === 0 && blocks.length === 0) return undefined
  const list = fitList({
    title: "## Current Space — what changed",
    lines,
    more: (count) => `+${count} more Space changes — use space_board_read`,
    budget: maxBytes
  })
  return [list ?? "## Current Space — what changed", ...blocks].join("\n\n")
}

const questionChanges = (previous: SpaceFacts, view: SpaceView): ReadonlyArray<string> => {
  const before = new Set(previous.questions.map((question) => question.id))
  const now = new Set(view.questions.map((question) => question.question_id))
  return [
    ...view.questions
      .filter((question) => !before.has(question.question_id))
      .map((question) => `- New question: ${questionLine(question).slice(2)}`),
    ...previous.questions
      .filter((question) => !now.has(question.id))
      .map((question) => `- No longer open: question "${question.prompt}".`)
  ]
}

const taskChanges = (
  previous: SpaceFacts,
  current: SpaceFacts,
  view: SpaceView
): ReadonlyArray<string> => {
  const before = new Map(previous.tasks.map((task) => [task.id, task]))
  const tracked = new Set(current.tasks.map((task) => task.id))
  const changed = rankedTasks(view.tasks.filter((task) => tracked.has(task.item_id))).flatMap(
    (task) => {
      const was = before.get(task.item_id)
      if (was === undefined) return [`- New Task: ${taskLine(task).slice(2)}`]
      const title = taskTitle(task)
      const state = stateWords(task).join(" · ")
      return [
        ...(was.title === title
          ? []
          : [`- Task "${was.title}" is now titled ${taskLink(task)} · key ${task.stable_key}`]),
        ...(was.state === state
          ? []
          : [`- Task ${taskLink(task)} is now ${state} (was ${was.state}).`])
      ]
    }
  )
  const gone = previous.tasks
    .filter((task) => !tracked.has(task.id) && isTaskUnfinished(task.status))
    .map((task) => `- Task "${task.title}" is no longer on this Space.`)
  return [...changed, ...gone]
}

const chatChanges = (
  previous: SpaceFacts,
  current: SpaceFacts,
  view: SpaceView
): ReadonlyArray<string> => {
  const before = new Map(previous.chats.map((chat) => [chat.id, chat]))
  const now = new Set(current.chats.map((chat) => chat.id))
  return [
    ...view.chats.slice(0, TRACKED_CHATS).flatMap((chat) => {
      const was = before.get(chat.session_id)
      if (was === undefined) return [`- New chat in this Space: ${chatLine(chat).slice(2)}`]
      return was.name === chat.name && was.summary === digest(chat.summary ?? "")
        ? []
        : [`- Chat updated: ${chatLine(chat).slice(2)}`]
    }),
    ...previous.chats
      .filter((chat) => !now.has(chat.id))
      .map((chat) => `- Chat "${chat.name}" is no longer in this Space.`)
  ]
}

const pageChange = (
  previous: SpaceFacts,
  current: SpaceFacts,
  view: SpaceView
): ReadonlyArray<string> => {
  if (
    previous.page?.path === current.page?.path &&
    previous.page?.content === current.page?.content
  )
    return []
  if (view.page === undefined) return ["The Space no longer has a memory page."]
  const block = pageBlock(
    view.page,
    SPACE_PAGE_MAX_BYTES,
    "The Space memory page changed; it now reads"
  )
  return block === undefined ? [] : [block.text]
}

const ACTIVITY_RANK: Record<SpaceTaskView["activity"], number> = {
  needs_you: 0,
  working: 1,
  stopped: 2,
  waiting: 3,
  on_hold: 4,
  idle: 5
}

const STATUS_RANK: Record<SpaceTaskView["status"], number> = {
  open: 0,
  deferred: 1,
  done: 2,
  cancelled: 2
}

const rankedTasks = (tasks: ReadonlyArray<SpaceTaskView>): ReadonlyArray<SpaceTaskView> =>
  tasks
    .map((task, index) => ({ task, index }))
    .sort(
      (left, right) =>
        STATUS_RANK[left.task.status] - STATUS_RANK[right.task.status] ||
        (isTaskUnfinished(left.task.status) ? ACTIVITY_RANK[left.task.activity] : 0) -
          (isTaskUnfinished(right.task.status) ? ACTIVITY_RANK[right.task.activity] : 0) ||
        left.index - right.index
    )
    .map((entry) => entry.task)

const stateWords = (task: SpaceTaskView): ReadonlyArray<string> => {
  if (!isTaskUnfinished(task.status)) return [task.status]
  return [task.status, task.owner, activityWords(task)]
}

const activityWords = (task: SpaceTaskView): string =>
  taskActivityWords(task, (reason) => cutText(reason, 160)) ?? "idle"

const taskTitle = (task: SpaceTaskView): string => clipLine(task.text, 160)

const linkLabel = (label: string): string => label.replace(/[\\[\]]/g, "\\$&")

const taskLink = (task: SpaceTaskView): string =>
  `[${linkLabel(taskTitle(task))}](arden:task/${encodeURIComponent(task.item_id)})`

const taskLine = (task: SpaceTaskView): string =>
  [
    `- ${taskLink(task)}`,
    ...stateWords(task),
    ...(isTaskUnfinished(task.status) && task.next_attempt_at !== null
      ? [`next check ${task.next_attempt_at}`]
      : []),
    `key ${task.stable_key}`
  ].join(" · ")

const questionLine = (question: SpaceQuestionView): string =>
  [
    `- "${clipLine(question.prompt, 400)}"`,
    ...(question.task === undefined ? [] : [`Task "${question.task}"`]),
    ...(question.detail === undefined ? [] : [`detail: ${clipLine(question.detail, 300)}`]),
    ...(question.choices.length === 0 ? [] : [`choices: ${question.choices.join(" / ")}`]),
    `question_id ${question.question_id}`
  ].join(" · ")

const chatLine = (chat: SpaceChatView): string => {
  const name = linkLabel(cutText(chat.name, 120))
  const link =
    chat.session_ref === undefined
      ? `"${name}" (session_id ${chat.session_id})`
      : `[${name}](arden:session/${chat.session_ref})`
  return chat.summary === undefined ? `- ${link}` : `- ${link} — ${clipLine(chat.summary, 300)}`
}

const pageBlock = (
  page: NonNullable<SpaceView["page"]>,
  budget: number,
  title = "Space memory page"
): { readonly text: string; readonly whole: boolean } | undefined => {
  const heading = `${title} (${page.path}):`
  const continues = `(The page continues; read ${page.path} for the rest.)`
  if (byteLength(heading) + byteLength(continues) + 2 > budget) return undefined
  if (byteLength(heading) + byteLength(page.content) + 1 <= budget)
    return { text: `${heading}\n${page.content}`, whole: true }
  const kept: Array<string> = []
  let used = byteLength(heading) + byteLength(continues) + 2
  for (const line of page.content.split("\n")) {
    const cost = byteLength(line) + 1
    if (used + cost > budget) break
    kept.push(line)
    used += cost
  }
  return { text: [heading, ...kept, continues].join("\n"), whole: false }
}

const fitList = ({
  title,
  lines,
  more,
  budget,
  hidden = 0
}: {
  readonly title: string
  readonly lines: ReadonlyArray<string>
  readonly more: (count: number) => string
  readonly budget: number
  readonly hidden?: number
}): string | undefined => {
  if (lines.length === 0) return undefined
  const kept: Array<string> = []
  let used = byteLength(title)
  for (const line of lines) {
    const cost = byteLength(line) + 1
    const isLast = kept.length === lines.length - 1 && hidden === 0
    if (used + cost + (isLast ? 0 : MORE_LINE_BYTES) > budget) break
    kept.push(line)
    used += cost
  }
  if (kept.length === 0 && used + MORE_LINE_BYTES > budget) return undefined
  const left = lines.length - kept.length
  return [title, ...kept, ...(left + hidden > 0 ? [more(left)] : [])].join("\n")
}

export const digest = (value: string): string => sha256Base64Url(value).slice(0, 16)
