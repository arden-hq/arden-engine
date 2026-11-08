import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { JobClassification } from "../job-classification.js"
import type {
  SpaceJobPromptContext,
  SpaceReviewSnapshot,
  TaskWorkerSnapshot
} from "../automations/job-prompt.js"
import { readJobSpace, readJobTask, type TaskRow } from "./space-job-rows.js"
import { taskHasHold } from "./task-hold-state.js"
import { stallStreakSql } from "./task-next-move.js"
import { taskRevisionRef } from "./work-history.js"
import { readTaskContract } from "./task-contract.js"
import { terminalRunStatusList } from "./status-sets.js"
import { readTaskState, type TaskStateView } from "../work/task-state.js"
import { taskOpenSql } from "./task-status-sql.js"

interface CommentRow {
  readonly author: string
  readonly body: string
  readonly created_at: string
}

const TASK_HISTORY_LINES = 5

const history = Effect.fn("SpaceJobSql.history")(function* (
  sql: SqlClient.SqlClient,
  itemId: string
) {
  const rows = yield* sql<{ readonly created_at: string; readonly summary: string }>`
    SELECT created_at, summary FROM space_task_events
    WHERE item_id = ${itemId} AND summary IS NOT NULL AND summary <> ''
      AND event_type <> 'scheduled'
    ORDER BY event_id DESC LIMIT ${TASK_HISTORY_LINES}
  `
  return rows.toReversed().map((line) => ({ at: line.created_at, summary: line.summary }))
})

const comments = Effect.fn("SpaceJobSql.comments")(function* (
  sql: SqlClient.SqlClient,
  itemId: string
) {
  return yield* sql<CommentRow>`
    SELECT author, body, created_at
    FROM space_task_comments
    WHERE item_id = ${itemId}
    ORDER BY created_at DESC, comment_id DESC
    LIMIT 20
  `
})

export const readSpaceReviewContext = Effect.fn("SpaceJobSql.spaceReviewContext")(function* (
  sql: SqlClient.SqlClient,
  spaceId: string
) {
  const current = yield* readJobSpace(sql, spaceId)
  if (current === null) return undefined
  const work = yield* sql<TaskRow & { readonly history_revision: string | null }>`
    SELECT item.item_id, item.space_id, item.stable_key, item.text, item.body,
           item.status, item.owner, item.blocked, item.waiting_on, item.due_at,
           item.next_attempt_at, item.updated_at, ${taskHasHold(sql, sql`item`)} AS held,
           space.name AS space_name, space.instructions AS space_instructions,
           space.page_id, space.page_path,
           space.archived_at AS space_archived_at,
           ${taskRevisionRef(
             sql,
             sql`item.item_id`,
             sql`(SELECT MAX(version) FROM space_task_revisions WHERE item_id = item.item_id)`
           )} AS history_revision
    FROM space_tasks AS item
    JOIN spaces AS space ON space.space_id = item.space_id
    WHERE item.space_id = ${spaceId}
      AND ${taskOpenSql("item")}
    ORDER BY item.item_id
    LIMIT 40
  `
  return {
    spaceId: current.space_id,
    name: current.name,
    instructions: current.instructions ?? undefined,
    pagePath: current.page_path ?? undefined,
    inferenceEnabled: current.inference_enabled === 1,
    openTasks: work.map((item) => ({
      itemId: item.item_id,
      historyRevision: item.history_revision,
      text: item.text,
      status: item.status,
      owner: item.owner,
      blocked: item.blocked === 1,
      waitingOn: item.waiting_on ?? undefined,
      held: item.held === 1
    }))
  } satisfies SpaceReviewSnapshot
})

const readStateView = Effect.fn("SpaceJobSql.taskStateView")(function* (
  sql: SqlClient.SqlClient,
  itemId: string,
  stored: string | null
) {
  const record = yield* readTaskState(stored)
  if (record === undefined) return undefined
  const writer =
    record.run_id === null
      ? []
      : yield* sql<{ readonly public_ref: string }>`
        SELECT session.public_ref FROM chat_runs AS run
        JOIN sessions AS session ON session.session_id = run.session_id
        WHERE run.run_id = ${record.run_id}`
  const later = yield* sql<{ readonly wakes: number }>`
    SELECT COUNT(*) AS wakes FROM chat_runs AS run
    JOIN sessions AS session ON session.session_id = run.session_id
    WHERE json_extract(run.metadata_json, '$.run_context.task.item_id') = ${itemId}
      AND session.session_type <> 'agent'
      AND run.status IN ${terminalRunStatusList}
      AND julianday(run.started_at) > julianday(${record.written_at})`
  return {
    record,
    sessionRef: writer[0]?.public_ref,
    laterWakes: later[0]?.wakes ?? 0
  } satisfies TaskStateView
})

export const readTaskWorkerContext = Effect.fn("SpaceJobSql.taskWorkerContext")(function* (
  sql: SqlClient.SqlClient,
  itemId: string
) {
  const task = yield* readJobTask(sql, itemId)
  if (task === null) return undefined
  const recent = yield* comments(sql, itemId)
  const lately = yield* history(sql, itemId)
  const stalls = yield* sql<{
    readonly stalls: number
  }>`SELECT ${stallStreakSql(sql, itemId)} AS stalls`
  const saved = yield* sql<{
    readonly attachment_id: number
    readonly name: string
    readonly created_at: string
  }>`
    SELECT attachment_id, name, created_at FROM space_task_attachments
    WHERE item_id = ${itemId} ORDER BY attachment_id DESC LIMIT 10`
  const questions = yield* sql<{ readonly prompt: string | null; readonly created_at: string }>`
    SELECT json_extract(question.content, '$.prompt') AS prompt, question.created_at
    FROM run_questions AS question
    JOIN chat_runs AS owner ON owner.run_id = question.run_id
    JOIN space_tasks AS item ON item.item_id = json_extract(owner.metadata_json, '$.run_context.task.item_id')
    WHERE item.item_id = ${itemId}
      AND json_extract(owner.metadata_json, '$.run_context.task.item_id') = +${itemId}
      AND item.generation = json_extract(owner.metadata_json, '$.run_context.task.generation')
      AND question.resolution IS NULL AND question.closed_at IS NULL
    ORDER BY question.created_at DESC LIMIT 1`
  const question = questions[0]
  const contract = yield* readTaskContract(sql, itemId)
  const state = yield* readStateView(sql, itemId, task.continuation_context)
  return {
    itemId: task.item_id,
    text: task.text,
    body: task.body ?? undefined,
    state,
    dueAt: task.due_at ?? undefined,
    nextAttemptAt: task.next_attempt_at ?? undefined,
    blockReason: task.blocked === 1 ? (task.block_reason ?? undefined) : undefined,
    status: task.status,
    owner: task.owner,
    blocked: task.blocked === 1,
    waitingOn: task.waiting_on ?? undefined,
    updatedAt: task.updated_at,
    space:
      task.space_id === null || task.space_name === null
        ? undefined
        : {
            spaceId: task.space_id,
            spaceName: task.space_name,
            spaceInstructions: task.space_instructions ?? undefined,
            pagePath: task.page_path ?? undefined
          },
    speaksIn: task.space_id === null || task.speaks_in_space_chat !== 1 ? "chat" : "space",
    history: lately,
    comments: recent.map((comment) => ({
      author: comment.author,
      body: comment.body,
      createdAt: comment.created_at
    })),
    saved: saved.map((file) => ({
      attachmentId: file.attachment_id,
      name: file.name,
      createdAt: file.created_at
    })),
    stalledRuns: stalls[0]?.stalls ?? 0,
    openQuestion:
      question?.prompt == null
        ? undefined
        : { prompt: question.prompt, askedAt: question.created_at },
    contract
  } satisfies TaskWorkerSnapshot
})

export const readSpaceJobContext = Effect.fn("SpaceJobSql.context")(function* (
  sql: SqlClient.SqlClient,
  automationId: string
) {
  const rows = yield* sql<JobClassification>`
    SELECT purpose, owner_space_id, owner_task_id FROM scheduled_tasks WHERE task_id = ${automationId} LIMIT 1
  `
  const job = rows[0]
  if (job?.purpose === "space_review") {
    return {
      kind: "space_review",
      space: yield* readSpaceReviewContext(sql, job.owner_space_id)
    } satisfies SpaceJobPromptContext
  }
  if (job?.purpose === "task_execution") {
    return {
      kind: "task_execution",
      task: yield* readTaskWorkerContext(sql, job.owner_task_id)
    } satisfies SpaceJobPromptContext
  }
  return undefined
})

export const readRunTaskContext = Effect.fn("SpaceJobSql.runTaskContext")(function* (
  sql: SqlClient.SqlClient,
  runId: string
) {
  const rows = yield* sql<{ readonly item_id: string }>`SELECT task.item_id FROM chat_runs AS run
    JOIN space_tasks AS task ON task.item_id = json_extract(run.metadata_json, '$.run_context.task.item_id')
      AND task.generation = json_extract(run.metadata_json, '$.run_context.task.generation')
    WHERE run.run_id = ${runId} AND ${taskOpenSql("task")}`
  return rows[0] === undefined ? undefined : yield* readTaskWorkerContext(sql, rows[0].item_id)
})
