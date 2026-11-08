import type { ChatProjectionEvent, TodoListItem } from "@arden-hq/protocol"
import type {
  EffectiveSessionTodo,
  EffectiveSessionTodoResponse,
  SetTodoOverrideRequest,
  TodoLifecycleResponse,
  TodoSnapshot
} from "@arden-hq/protocol/sessions/todos"
import {
  SetTodoOverrideRequestSchema,
  TodoSnapshotSchema
} from "@arden-hq/protocol/effect/sessions/todos"
import { TodoListItemSchema } from "@arden-hq/protocol/effect/common"
import { DateTime, Effect, Schema } from "effect"
import { TodoStore, TodoStoreError } from "../todos/store.js"
import { assignTodoIds } from "../todos/items.js"
import { decodeJson, encodeJson } from "./json.js"
import { IdGenerator, type PersistenceDeps } from "./deps.js"

interface TodoRow {
  readonly items_json: string
  readonly explanation: string | null
  readonly updated_at: string
}

interface EffectiveTodoRow extends TodoRow {
  readonly edited: number
}

const TodoItemsSchema = Schema.Array(TodoListItemSchema)
type TodoOperation = "get" | "set_agent" | "set_override" | "clear" | "clear_override"

const todoError = (
  operation: TodoOperation,
  reason: "invalid" | "not_found" | "conflict" | "storage",
  message: string,
  sessionId?: string,
  cause?: unknown
): TodoStoreError =>
  new TodoStoreError({
    operation,
    reason,
    message,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(cause === undefined ? {} : { cause })
  })

const sessionId = Effect.fn("SqliteTodoStore.sessionId")(function* (
  value: string,
  operation: TodoOperation
) {
  return yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(value).pipe(
    Effect.mapError((cause) =>
      todoError(operation, "invalid", "Session id must not be empty", undefined, cause)
    )
  )
})

const decodeSnapshot = Effect.fn("SqliteTodoStore.decodeSnapshot")(function* (
  row: TodoRow,
  operation: "get" | "set_agent" | "set_override",
  id: string
): Effect.fn.Return<TodoSnapshot, TodoStoreError> {
  const items = yield* decodeJson(TodoItemsSchema, row.items_json).pipe(
    Effect.mapError((cause) =>
      todoError(operation, "storage", "Stored todo items are corrupt", id, cause)
    )
  )
  return yield* Schema.decodeUnknownEffect(TodoSnapshotSchema)({
    items,
    explanation: row.explanation,
    updated_at: row.updated_at
  }).pipe(
    Effect.mapError((cause) =>
      todoError(operation, "storage", "Stored todo snapshot is corrupt", id, cause)
    )
  )
})

const decodeEffective = Effect.fn("SqliteTodoStore.decodeEffective")(function* (
  row: EffectiveTodoRow,
  id: string
): Effect.fn.Return<EffectiveSessionTodo, TodoStoreError> {
  const snapshot = yield* decodeSnapshot(row, "get", id)
  return { ...snapshot, edited: row.edited !== 0 }
})

const lifecycle = (id: string, cleared: boolean): TodoLifecycleResponse => ({
  status: cleared ? "cleared" : "noop",
  session_id: id
})

const preserveTodoError =
  (operation: TodoOperation, id: string, message: string) => (cause: unknown) =>
    cause instanceof TodoStoreError ? cause : todoError(operation, "storage", message, id, cause)

export const makeTodoStore = ({
  writer,
  chatEvents
}: Pick<PersistenceDeps, "writer" | "chatEvents">): TodoStore["Service"] => {
  const sql = writer.sql
  const get = Effect.fn("SqliteTodoStore.get")(function* (
    value: string
  ): Effect.fn.Return<EffectiveSessionTodoResponse, TodoStoreError> {
    const id = yield* sessionId(value, "get")
    const rows = yield* sql<EffectiveTodoRow>`
      SELECT items_json, explanation, updated_at, edited
      FROM session_todos
      WHERE session_id = ${id}
      ORDER BY edited DESC
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        todoError("get", "storage", "Could not read session todo", id, cause)
      )
    )
    const row = rows[0]
    return row === undefined ? null : yield* decodeEffective(row, id)
  })

  const identified = Effect.fn("SqliteTodoStore.identified")(function* (
    id: string,
    items: SetTodoOverrideRequest["items"]
  ) {
    const rows = yield* sql<{ readonly items_json: string }>`
      SELECT items_json FROM session_todos WHERE session_id = ${id}
      ORDER BY edited DESC LIMIT 1
    `
    const previous =
      rows[0] === undefined
        ? []
        : yield* decodeJson(TodoItemsSchema, rows[0].items_json).pipe(
            Effect.orElseSucceed(() => [])
          )
    const ids = yield* IdGenerator
    return assignTodoIds({ previous, next: items, newId: ids.next })
  })

  const getOverride = Effect.fn("SqliteTodoStore.getOverride")(function* (
    value: string
  ): Effect.fn.Return<TodoSnapshot | null, TodoStoreError> {
    const id = yield* sessionId(value, "get")
    const rows = yield* sql<TodoRow>`
      SELECT items_json, explanation, updated_at
      FROM session_todos
      WHERE session_id = ${id} AND edited = 1
    `.pipe(
      Effect.mapError((cause) =>
        todoError("get", "storage", "Could not read session todo override", id, cause)
      )
    )
    const row = rows[0]
    return row === undefined ? null : yield* decodeSnapshot(row, "get", id)
  })

  const setAgent = Effect.fn("SqliteTodoStore.setAgent")(function* (
    value: string,
    runId: string,
    toolCallId: string,
    request: SetTodoOverrideRequest
  ): Effect.fn.Return<TodoSnapshot, TodoStoreError> {
    const id = yield* sessionId(value, "set_agent")
    const [input, validRunId, validToolCallId] = yield* Effect.all([
      Schema.decodeUnknownEffect(SetTodoOverrideRequestSchema)(request),
      Schema.decodeUnknownEffect(Schema.NonEmptyString)(runId),
      Schema.decodeUnknownEffect(Schema.NonEmptyString)(toolCallId)
    ]).pipe(
      Effect.mapError((cause) =>
        todoError("set_agent", "invalid", "Invalid agent todo update", id, cause)
      )
    )
    const completed = input.items.every((item) => item.status === "completed")
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const sessions = yield* sql<{ readonly session_id: string }>`
          SELECT session_id FROM sessions WHERE session_id = ${id} LIMIT 1
        `.pipe(
            Effect.mapError((cause) =>
              todoError("set_agent", "storage", "Could not read Session for todo update", id, cause)
            )
          )
          if (sessions.length === 0) {
            return yield* todoError("set_agent", "not_found", "Session not found", id)
          }
          const items: ReadonlyArray<TodoListItem> = yield* identified(id, input.items).pipe(
            Effect.mapError((cause) =>
              todoError("set_agent", "storage", "Could not read the Session todo", id, cause)
            )
          )
          const itemsJson = yield* encodeJson(TodoItemsSchema, items).pipe(
            Effect.mapError((cause) =>
              todoError("set_agent", "invalid", "Agent todo items cannot be encoded", id, cause)
            )
          )
          const updatedAt = DateTime.formatIso(yield* DateTime.now)
          const retire = completed
            ? sql`DELETE FROM session_todos WHERE session_id = ${id}`
            : sql`DELETE FROM session_todos WHERE session_id = ${id} AND edited = 1`
          yield* retire.pipe(
            Effect.mapError((cause) =>
              todoError("set_agent", "storage", "Could not clear the Session todo", id, cause)
            )
          )
          if (!completed) {
            yield* sql`
            INSERT INTO session_todos (session_id, edited, items_json, explanation, updated_at)
            VALUES (${id}, 0, ${itemsJson}, ${input.explanation ?? null}, ${updatedAt})
            ON CONFLICT(session_id, edited) DO UPDATE SET
              items_json = excluded.items_json,
              explanation = excluded.explanation,
              updated_at = excluded.updated_at
          `.pipe(
              Effect.mapError((cause) =>
                todoError("set_agent", "storage", "Could not save the Session todo", id, cause)
              )
            )
          }
          const snapshot = yield* Schema.decodeUnknownEffect(TodoSnapshotSchema)({
            items,
            explanation: input.explanation ?? null,
            updated_at: updatedAt
          }).pipe(
            Effect.mapError((cause) =>
              todoError("set_agent", "storage", "Saved agent todo is invalid", id, cause)
            )
          )
          yield* chatEvents
            .appendInTransaction({
              sessionId: id,
              events: [
                {
                  event: {
                    type: "todo_updated",
                    run_id: validRunId,
                    tool_call_id: validToolCallId,
                    explanation: input.explanation ?? null,
                    items
                  } satisfies ChatProjectionEvent
                }
              ]
            })
            .pipe(
              Effect.mapError((cause) =>
                todoError(
                  "set_agent",
                  "storage",
                  "Could not commit the todo update event",
                  id,
                  cause
                )
              )
            )
          return snapshot
        })
      )
      .pipe(
        Effect.mapError(preserveTodoError("set_agent", id, "Could not complete agent todo update"))
      )
  })

  const setOverride = Effect.fn("SqliteTodoStore.setOverride")(function* (
    value: string,
    request: SetTodoOverrideRequest
  ): Effect.fn.Return<TodoSnapshot, TodoStoreError> {
    const id = yield* sessionId(value, "set_override")
    const input = yield* Schema.decodeUnknownEffect(SetTodoOverrideRequestSchema)(request).pipe(
      Effect.mapError((cause) =>
        todoError("set_override", "invalid", "Invalid todo override", id, cause)
      )
    )
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const items = yield* identified(id, input.items).pipe(
            Effect.mapError((cause) =>
              todoError("set_override", "storage", "Could not read the Session todo", id, cause)
            )
          )
          const itemsJson = yield* encodeJson(TodoItemsSchema, items).pipe(
            Effect.mapError((cause) =>
              todoError(
                "set_override",
                "invalid",
                "Todo override items cannot be encoded",
                id,
                cause
              )
            )
          )
          const updatedAt = DateTime.formatIso(yield* DateTime.now)
          const rows = yield* sql<TodoRow>`
        INSERT INTO session_todos (session_id, edited, items_json, explanation, updated_at)
        SELECT ${id}, 1, ${itemsJson}, ${input.explanation ?? null}, ${updatedAt}
        FROM sessions
        WHERE session_id = ${id}
        ON CONFLICT(session_id, edited) DO UPDATE SET
          items_json = excluded.items_json,
          explanation = excluded.explanation,
          updated_at = excluded.updated_at
        RETURNING items_json, explanation, updated_at
      `.pipe(
            Effect.mapError((cause) =>
              todoError("set_override", "storage", "Could not save todo override", id, cause)
            )
          )
          const row = rows[0]
          if (row !== undefined) return yield* decodeSnapshot(row, "set_override", id)
          return yield* todoError("set_override", "not_found", "Session not found", id)
        })
      )
      .pipe(
        Effect.mapError(
          preserveTodoError("set_override", id, "Could not complete todo override write")
        )
      )
  })

  const clear = Effect.fn("SqliteTodoStore.clear")(function* (
    value: string
  ): Effect.fn.Return<TodoLifecycleResponse, TodoStoreError> {
    const id = yield* sessionId(value, "clear")
    return yield* writer
      .transact(
        sql<{ readonly session_id: string }>`
          DELETE FROM session_todos WHERE session_id = ${id} RETURNING session_id
        `.pipe(
          Effect.map((rows) => lifecycle(id, rows.length > 0)),
          Effect.mapError((cause) =>
            todoError("clear", "storage", "Could not clear todo", id, cause)
          )
        )
      )
      .pipe(Effect.mapError(preserveTodoError("clear", id, "Could not complete todo clear")))
  })

  const clearOverride = Effect.fn("SqliteTodoStore.clearOverride")(function* (
    value: string
  ): Effect.fn.Return<TodoLifecycleResponse, TodoStoreError> {
    const id = yield* sessionId(value, "clear_override")
    const rows = yield* sql<{ readonly session_id: string }>`
      DELETE FROM session_todos WHERE session_id = ${id} AND edited = 1 RETURNING session_id
    `.pipe(
      Effect.mapError((cause) =>
        todoError("clear_override", "storage", "Could not clear todo override", id, cause)
      )
    )
    return lifecycle(id, rows.length > 0)
  })

  return TodoStore.of({ get, getOverride, setAgent, setOverride, clear, clearOverride })
}
