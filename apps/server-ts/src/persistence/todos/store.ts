import { storeErrorFields } from "../errors.js"
import type {
  EffectiveSessionTodoResponse,
  SetTodoOverrideRequest,
  TodoLifecycleResponse,
  TodoSnapshot
} from "@arden-hq/protocol/sessions/todos"
import { Context, Effect, Schema } from "effect"

export class TodoStoreError extends Schema.TaggedError<TodoStoreError>()("TodoStoreError", {
  ...storeErrorFields({
    operations: ["get", "set_agent", "set_override", "clear", "clear_override"],
    reasons: ["invalid", "not_found", "conflict", "storage"]
  }),
  sessionId: Schema.optionalKey(Schema.NonEmptyString)
}) {}

export class TodoStore extends Context.Service<
  TodoStore,
  {
    readonly get: (sessionId: string) => Effect.Effect<EffectiveSessionTodoResponse, TodoStoreError>
    readonly getOverride: (sessionId: string) => Effect.Effect<TodoSnapshot | null, TodoStoreError>
    readonly setOverride: (
      sessionId: string,
      request: SetTodoOverrideRequest
    ) => Effect.Effect<TodoSnapshot, TodoStoreError>
    readonly setAgent: (
      sessionId: string,
      runId: string,
      toolCallId: string,
      request: SetTodoOverrideRequest
    ) => Effect.Effect<TodoSnapshot, TodoStoreError>
    readonly clear: (sessionId: string) => Effect.Effect<TodoLifecycleResponse, TodoStoreError>
    readonly clearOverride: (
      sessionId: string
    ) => Effect.Effect<TodoLifecycleResponse, TodoStoreError>
  }
>()("@arden-hq/server/persistence/todos/TodoStore") {}
