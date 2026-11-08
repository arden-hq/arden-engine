import { DateTime, Effect, Schema } from "effect"
import { WorkStoreError, type WorkStore } from "../work/store.js"
import { workError } from "./work-records.js"
import { readTaskResults } from "./work-results.js"
import { isOrdinaryChat, requireInChatHome } from "./in-chat-task.js"
import { taskUnfinishedSql } from "./task-status-sql.js"
import type { Writer } from "./deps.js"

export const makeWorkVisibility = ({
  writer
}: {
  readonly writer: Writer
}): Pick<WorkStore["Service"], "moveToChat" | "acknowledgeResult"> => {
  const sql = writer.sql
  const activeTask = Effect.fn("WorkVisibility.activeTask")(function* (itemId: string) {
    const rows = yield* sql`
      SELECT 1 FROM space_tasks AS item LEFT JOIN spaces AS space ON space.space_id = item.space_id
      WHERE item.item_id = ${itemId}
        AND (item.space_id IS NULL OR space.archived_at IS NULL)
    `
    if (!rows[0]) return yield* workError("not_found", "Task not found")
  })
  const failure = (cause: unknown) =>
    cause instanceof WorkStoreError
      ? cause
      : workError("storage", "Could not update Task visibility", cause)

  const moveToChat: WorkStore["Service"]["moveToChat"] = Effect.fn("Work.moveToChat")(
    function* (request) {
      const valid = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ itemId: Schema.NonEmptyString, sessionId: Schema.NonEmptyString })
      )(request).pipe(
        Effect.mapError((cause) => workError("invalid", "Invalid Task move request", cause))
      )
      yield* writer
        .transact(
          Effect.gen(function* () {
            yield* activeTask(valid.itemId)
            if (!(yield* isOrdinaryChat(sql, valid.sessionId)))
              return yield* workError(
                "invalid",
                "Move it to an ordinary chat; a Space's own chat, an Automation's or an agent's cannot hold a Task"
              )
            const task = (yield* sql<{
              readonly home_session_id: string | null
              readonly space_id: string | null
              readonly stable_key: string
              readonly runs_in: string
              readonly unfinished: number
            }>`SELECT home_session_id, space_id, stable_key, runs_in,
                ${taskUnfinishedSql()} AS unfinished
              FROM space_tasks WHERE item_id = ${valid.itemId}`)[0]
            if (task === undefined) return yield* workError("not_found", "Task not found")
            if (task.home_session_id === valid.sessionId) return
            if (task.runs_in === "chat" && task.unfinished === 1)
              yield* requireInChatHome(sql, { sessionId: valid.sessionId, itemId: valid.itemId })
            if (task.space_id === null) {
              const taken = yield* sql`SELECT 1 FROM space_tasks
                WHERE space_id IS NULL AND home_session_id = ${valid.sessionId}
                  AND stable_key = ${task.stable_key} AND item_id <> ${valid.itemId}`
              if (taken.length > 0)
                return yield* workError(
                  "conflict",
                  "That chat already has a Task with this name. Rename one first"
                )
            }
            yield* sql`UPDATE space_tasks
              SET home_session_id = ${valid.sessionId},
                updated_at = MAX(updated_at, ${DateTime.formatIso(yield* DateTime.now)})
              WHERE item_id = ${valid.itemId}`
          })
        )
        .pipe(Effect.mapError(failure))
    }
  )

  const acknowledgeResult: WorkStore["Service"]["acknowledgeResult"] = Effect.fn(
    "Work.acknowledgeResult"
  )(function* (request) {
    const valid = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        itemId: Schema.NonEmptyString,
        resultKey: Schema.NonEmptyString
      })
    )(request).pipe(
      Effect.mapError((cause) => workError("invalid", "Invalid result-read request", cause))
    )
    yield* writer
      .transact(
        Effect.gen(function* () {
          yield* activeTask(valid.itemId)
          const result = (yield* readTaskResults(sql, [valid.itemId]))[0]
          if (result === undefined || result.result_key !== valid.resultKey || !result.unseen)
            return
          yield* sql`INSERT INTO space_task_result_reads(item_id, result_key, read_at)
        VALUES (${valid.itemId}, ${valid.resultKey}, ${DateTime.formatIso(yield* DateTime.now)})
        ON CONFLICT(item_id) DO UPDATE SET result_key = excluded.result_key, read_at = excluded.read_at`
        })
      )
      .pipe(Effect.mapError(failure))
  })
  return { moveToChat, acknowledgeResult }
}
