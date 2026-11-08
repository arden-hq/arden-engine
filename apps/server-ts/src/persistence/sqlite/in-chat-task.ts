import { DateTime, Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"
import {
  WorkStoreError,
  type ChatTaskContext,
  type InChatStep,
  type SpentScope,
  type WorkStore
} from "../work/store.js"
import type { Writer } from "./deps.js"
import { workError } from "./work-records.js"
import { captureRunTask } from "./run-context.js"
import { hasPendingTaskQuestion } from "./task-question-state.js"
import { activeRunStatusList } from "./status-sets.js"
import { readTaskWorkerContext } from "./space-job-context.js"
import { stoppedSinceMovedSql } from "./task-next-move.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import type { QueueWriter } from "./automation-enqueue.js"
import { journalTaskHistory, type AddedTaskHistory } from "./task-history.js"
import { taskOpenSql, taskUnfinishedSql } from "./task-status-sql.js"
import { BUDGET_SPENT, blockTaskOnYou } from "./task-block.js"
import { taskMayWakeSql } from "./task-wake.js"
import { userChatSql } from "./chat-ownership.js"

export const isOrdinaryChat = Effect.fn("InChatTask.isOrdinaryChat")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
): Effect.fn.Return<boolean, WorkStoreError> {
  const rows = yield* sql`SELECT 1 FROM sessions AS chat
    WHERE chat.session_id = ${sessionId} AND ${userChatSql("chat")}
      AND chat.parent_session_id IS NULL AND chat.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM space_conversations AS conversation
        WHERE conversation.session_id = chat.session_id)`.pipe(
    Effect.mapError((cause) => workError("storage", "Could not read the chat", cause))
  )
  return rows.length > 0
})

export const requireInChatHome = Effect.fn("InChatTask.requireHome")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly sessionId: string
    readonly itemId?: string
  }
): Effect.fn.Return<void, WorkStoreError> {
  const rows = yield* sql<{
    readonly space_conversation: number
    readonly taken: number
  }>`
    SELECT
      EXISTS (SELECT 1 FROM space_conversations AS conversation
        WHERE conversation.session_id = chat.session_id) AS space_conversation,
      EXISTS (SELECT 1 FROM space_tasks AS other
        WHERE other.home_session_id = chat.session_id AND other.runs_in = 'chat'
          AND ${taskUnfinishedSql("other")}
          AND other.item_id IS NOT ${input.itemId ?? null}) AS taken
    FROM sessions AS chat
    WHERE chat.session_id = ${input.sessionId} AND ${userChatSql("chat")} AND chat.archived_at IS NULL
  `.pipe(Effect.mapError((cause) => workError("storage", "Could not read the chat", cause)))
  const chat = rows[0]
  if (chat === undefined) return yield* workError("invalid", "A Task runs only in an ordinary chat")
  if (chat.space_conversation === 1)
    return yield* workError(
      "invalid",
      "A Space's own chat never works a Task in place; it runs in the background"
    )
  if (chat.taken === 1)
    return yield* workError("conflict", "This chat already works on another Task")
})

export const ensureTaskBudget = Effect.fn("InChatTask.ensureBudget")(function* (
  sql: SqlClient.SqlClient,
  itemId: string,
  tokenLimit: number | null
) {
  yield* sql`
    INSERT INTO execution_budgets (budget_id, task_item_id, token_limit)
    VALUES (${`task:${itemId}`}, ${itemId}, ${tokenLimit})
    ON CONFLICT (task_item_id) WHERE task_item_id IS NOT NULL
      DO UPDATE SET token_limit = excluded.token_limit
  `.pipe(
    Effect.mapError((cause) => workError("storage", "Could not keep the Task's budget", cause))
  )
})

export const liftsBudgetStop = (tokensUsed: number | undefined, tokenLimit: number | null) =>
  tokensUsed !== undefined && (tokenLimit === null || tokenLimit > tokensUsed)

const spentScopeSql = (sql: SqlClient.SqlClient, scope: SpentScope) => {
  if ("runId" in scope)
    return sql`budget.budget_id = (SELECT json_extract(run.metadata_json, '$.run_policy.budget_id')
      FROM chat_runs AS run WHERE run.run_id = ${scope.runId})`
  if ("sessionId" in scope)
    return sql`item.home_session_id = ${scope.sessionId} AND item.runs_in = 'chat'`
  return sql`item.item_id = ${scope.itemId}`
}

export const stopSpentTasks = Effect.fn("InChatTask.stopSpent")(function* (
  { sql, sessionEvents }: QueueWriter,
  scope: SpentScope,
  now: string
) {
  const stopped = yield* blockTaskOnYou(sql, {
    at: now,
    fence: false,
    where: sql`item_id IN (
      SELECT item.item_id FROM space_tasks AS item
      JOIN execution_budgets AS budget ON budget.task_item_id = item.item_id
      WHERE ${spentScopeSql(sql, scope)} AND ${taskOpenSql("item")} AND item.blocked = 0
        AND budget.token_limit IS NOT NULL AND budget.tokens_used >= budget.token_limit)`
  }).pipe(Effect.mapError((cause) => workError("storage", "Could not stop a spent Task", cause)))
  for (const task of stopped)
    yield* sql<AddedTaskHistory>`INSERT INTO space_task_events (space_id, item_id, run_ref, operation_index, event_type,
        summary, created_at)
      VALUES (${task.space_id}, ${task.item_id}, NULL, NULL, 'blocked', ${BUDGET_SPENT}, ${now})
      RETURNING event_id, item_id, run_ref`.pipe(
      Effect.flatMap((added) => journalTaskHistory(sql, sessionEvents, added)),
      Effect.mapError((cause) => workError("storage", "Could not record a spent Task", cause))
    )
  return stopped
})

const workingOnTaskSql = (
  sql: SqlClient.SqlClient,
  item: Statement.Fragment,
  home: Statement.Fragment,
  where: "chat" | "background"
): Statement.Fragment => {
  const inChat = sql`COALESCE(json_extract(working.metadata_json, '$.run_context.origin.kind') = 'chat'
    AND json_extract(working.metadata_json, '$.run_context.origin.session_id') = ${home}, 0)`
  return sql`json_extract(working.metadata_json, '$.run_context.task.item_id') = ${item}
    AND working.status IN ${activeRunStatusList}
    AND ${inChat} = ${where === "chat" ? 1 : 0}`
}

const activeTaskRunsSql = (sql: SqlClient.SqlClient, itemId: string) => sql`
  SELECT run_id FROM chat_runs
  WHERE status IN ${activeRunStatusList}
    AND json_extract(metadata_json, '$.run_context.task.item_id') = ${itemId}
  ORDER BY started_at, run_id`

const runnableInChatSql = (sql: SqlClient.SqlClient, now: string): Statement.Fragment => sql`
  item.runs_in = 'chat' AND ${taskMayWakeSql(sql, "item")}
  AND NOT ${hasPendingTaskQuestion(sql, sql`item.item_id`)}
  AND NOT ${stoppedSinceMovedSql(sql, sql`item.item_id`)}
  AND NOT EXISTS (SELECT 1 FROM chat_runs AS working
    WHERE ${workingOnTaskSql(sql, sql`item.item_id`, sql`item.home_session_id`, "background")})
  AND (item.next_attempt_at IS NULL OR item.next_attempt_at <= ${now})
  AND NOT EXISTS (SELECT 1 FROM execution_budgets AS budget
    WHERE budget.task_item_id = item.item_id AND budget.token_limit IS NOT NULL
      AND budget.tokens_used >= budget.token_limit)
  AND EXISTS (SELECT 1 FROM sessions AS chat
    WHERE chat.session_id = item.home_session_id AND chat.archived_at IS NULL)`

export const bindInChatTask = Effect.fn("InChatTask.bind")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly itemId: string; readonly sessionId: string }
) {
  const at = DateTime.formatIso(yield* DateTime.now)
  const homes = yield* sql<{ readonly space_id: string | null; readonly runnable: number }>`
    SELECT item.space_id, (${runnableInChatSql(sql, at)}) AS runnable FROM space_tasks AS item
    WHERE item.item_id = ${input.itemId} AND item.home_session_id = ${input.sessionId}
      AND item.runs_in = 'chat'
  `.pipe(Effect.mapError((cause) => workError("storage", "Could not read the Task", cause)))
  const home = homes[0]
  if (home === undefined)
    return yield* workError("conflict", "The Task no longer runs in this chat")
  if (home.runnable !== 1) return yield* workError("conflict", "The Task has no step to take now")
  return yield* captureRunTask({ sql, itemId: input.itemId, spaceId: home.space_id })
})

const readSteps = (
  sql: SqlClient.SqlClient,
  where: Statement.Fragment,
  now: string
): Effect.Effect<ReadonlyArray<InChatStep>, WorkStoreError> =>
  sql<{
    readonly item_id: string
    readonly home_session_id: string
    readonly text: string
    readonly approval_mode: string | null
  }>`
    SELECT item.item_id, item.home_session_id, item.text,
      (SELECT json_extract(chat.metadata, '$.approval_mode') FROM sessions AS chat
        WHERE chat.session_id = item.home_session_id) AS approval_mode
    FROM space_tasks AS item
    WHERE ${where} AND ${runnableInChatSql(sql, now)}
    ORDER BY item.updated_at, item.item_id
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        itemId: row.item_id,
        sessionId: row.home_session_id,
        text: row.text,
        approvalMode: row.approval_mode
      }))
    ),
    Effect.mapError((cause) => workError("storage", "Could not read the chat's Task", cause))
  )

const nextInChatStep = (
  sql: SqlClient.SqlClient,
  scope: { readonly sessionId: string } | { readonly itemId: string },
  now: string
) =>
  readSteps(
    sql,
    "sessionId" in scope
      ? sql`item.home_session_id = ${scope.sessionId}`
      : sql`item.item_id = ${scope.itemId}`,
    now
  ).pipe(Effect.map((steps) => steps[0]))

const idleInChatSteps = (sql: SqlClient.SqlClient, now: string) =>
  readSteps(
    sql,
    sql`NOT EXISTS (SELECT 1 FROM chat_runs AS run
      WHERE run.session_id = item.home_session_id AND run.status IN ${activeRunStatusList})
    -- An answer on its way carries the Task on.
    AND NOT EXISTS (SELECT 1 FROM automation_deliveries AS delivery
      WHERE delivery.status = 'pending' AND json_extract(delivery.payload, '$.kind') = 'answer'
        AND json_extract(delivery.payload, '$.sessionId') = item.home_session_id)`,
    now
  )

const readChatTask = Effect.fn("InChatTask.readChatTask")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string
): Effect.fn.Return<ChatTaskContext | undefined, WorkStoreError> {
  const rows = yield* sql<{ readonly item_id: string; readonly stable_key: string }>`
    SELECT item_id, stable_key FROM space_tasks
    WHERE home_session_id = ${sessionId} AND runs_in = 'chat'
      AND ${taskUnfinishedSql()}
    LIMIT 1
  `.pipe(Effect.mapError((cause) => workError("storage", "Could not read the chat's Task", cause)))
  const row = rows[0]
  if (row === undefined) return undefined
  const task = yield* readTaskWorkerContext(sql, row.item_id).pipe(
    Effect.mapError((cause) => workError("storage", "Could not read the chat's Task", cause))
  )
  if (task === undefined) return undefined
  return { key: row.stable_key, task }
})

export const makeInChatTaskStore = (options: {
  readonly writer: Writer
  readonly sessionEvents: SessionLifecycleEvents["Service"]
}): Pick<
  WorkStore["Service"],
  "stopSpent" | "nextInChat" | "idleInChat" | "chatTask" | "runsInChat" | "activeTaskRuns"
> => {
  const { writer } = options
  const sql = writer.sql
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso))
  return {
    stopSpent: (scope) =>
      writer
        .transact(
          Effect.gen(function* () {
            yield* stopSpentTasks({ sql, sessionEvents: options.sessionEvents }, scope, yield* now)
          })
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof WorkStoreError
              ? cause
              : workError("storage", "Could not check the Task's budget", cause)
          )
        ),
    nextInChat: (scope) => now.pipe(Effect.flatMap((at) => nextInChatStep(sql, scope, at))),
    idleInChat: () => now.pipe(Effect.flatMap((at) => idleInChatSteps(sql, at))),
    chatTask: (sessionId) => readChatTask(sql, sessionId),
    runsInChat: (itemId) =>
      sql`SELECT 1 FROM space_tasks WHERE item_id = ${itemId} AND runs_in = 'chat'`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError((cause) =>
          workError("storage", "Could not read where the Task runs", cause)
        )
      ),
    activeTaskRuns: (itemId) =>
      sql<{ readonly run_id: string }>`${activeTaskRunsSql(sql, itemId)}`.pipe(
        Effect.map((rows) => rows.map((row) => row.run_id)),
        Effect.mapError((cause) => workError("storage", "Could not read the Task's runs", cause))
      )
  }
}
