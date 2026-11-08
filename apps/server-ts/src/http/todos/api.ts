import {
  EffectiveSessionTodoResponseSchema,
  SetTodoOverrideRequestSchema,
  TodoLifecycleResponseSchema,
  TodoSnapshotSchema
} from "@arden-hq/protocol/effect/sessions/todos"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { StoreInvalid, StoreConflict } from "../errors.js"

export class TodosApi extends HttpApiGroup.make("todos", { topLevel: true }).add(
  HttpApiEndpoint.get("get", "/sessions/:sessionId/todo", {
    params: { sessionId: Schema.NonEmptyString },
    success: EffectiveSessionTodoResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.post("set", "/sessions/:sessionId/todo", {
    params: { sessionId: Schema.NonEmptyString },
    payload: SetTodoOverrideRequestSchema,
    success: TodoSnapshotSchema,
    error: [
      StoreInvalid,
      HttpApiError.NotFoundNoContent,
      StoreConflict,
      HttpApiError.InternalServerErrorNoContent
    ]
  }),
  HttpApiEndpoint.delete("clear", "/sessions/:sessionId/todo", {
    params: { sessionId: Schema.NonEmptyString },
    success: TodoLifecycleResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  }),
  HttpApiEndpoint.delete("clearOverride", "/sessions/:sessionId/todo/override", {
    params: { sessionId: Schema.NonEmptyString },
    success: TodoLifecycleResponseSchema,
    error: [HttpApiError.InternalServerErrorNoContent]
  })
) {}
