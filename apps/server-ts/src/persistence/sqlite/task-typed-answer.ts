import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import { appendQuestionChange } from "./question-events.js"
import { answerQuestionInTransaction } from "./question-settle.js"
import { writeError } from "./chat-write-errors.js"
import { userContent } from "../transcript/user-content.js"
import { taskOpenSql } from "./task-status-sql.js"

export const answerChatTaskQuestionByTypingInTransaction = Effect.fn("Task.answerByTyping")(
  function* (options: {
    readonly sql: SqlClient.SqlClient
    readonly sessionEvents: SessionLifecycleEvents["Service"]
    readonly input: {
      readonly sessionId: string
      readonly clientId: string
      readonly message: { readonly [key: string]: unknown }
    }
    readonly now: string
  }) {
    const { sql, input } = options
    const open = yield* sql<{ readonly question_id: string }>`
      SELECT question.question_id
      FROM space_tasks AS item
      JOIN chat_runs AS run
        ON json_extract(run.metadata_json, '$.run_context.task.item_id') = +item.item_id
        AND json_extract(run.metadata_json, '$.run_context.task.generation') = item.generation
      JOIN run_questions AS question ON question.run_id = run.run_id
      WHERE item.home_session_id = ${input.sessionId} AND item.runs_in = 'chat'
        AND ${taskOpenSql("item")}
        AND question.resolution IS NULL AND question.closed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM permission_offers WHERE question_id = question.question_id)
        AND NOT EXISTS (SELECT 1 FROM task_contract_proposals WHERE question_id = question.question_id)
      ORDER BY question.created_at DESC, question.question_id DESC
      LIMIT 1`
    const questionId = open[0]?.question_id
    if (questionId === undefined) return
    const content = input.message["content"]
    const text = typeof content === "string" ? content : userContent(content).text
    const said = text.trim().slice(0, 8000).trim()
    yield* answerQuestionInTransaction({
      sql,
      questionId,
      clientId: input.clientId.slice(0, 1024),
      answer: { kind: "text", text: said.length > 0 ? said : "(sent without text)" },
      now: options.now
    })
    yield* appendQuestionChange({ sql, sessionEvents: options.sessionEvents, questionId })
  },
  Effect.mapError((cause) =>
    writeError("start", "storage", "Could not answer the Task's question", { cause })
  )
)
