import { decoderFor, makeEncoder, runBoundary } from "../../common/boundary.js"
import type { SetTodoOverrideRequest } from "./contracts.js"
import {
  EffectiveSessionTodoResponseSchema,
  encodeSetTodoOverrideRequestEffect,
  TodoLifecycleResponseSchema,
  TodoSnapshotSchema
} from "./schema.js"
import { encodeTodoOverridePathEffect, encodeTodoPathEffect } from "./routes.js"

export * from "./contracts.js"

export const todoDecoders = {
  response: decoderFor(EffectiveSessionTodoResponseSchema, "Invalid session-todo response"),
  setResponse: decoderFor(TodoSnapshotSchema, "Invalid todo-override response"),
  lifecycleResponse: decoderFor(TodoLifecycleResponseSchema, "Invalid todo lifecycle response")
} as const

export const todoRequests = {
  setOverride: makeEncoder<SetTodoOverrideRequest>(
    encodeSetTodoOverrideRequestEffect,
    "Invalid todo-override request"
  )
} as const

/** The item path serves GET, POST, and DELETE. */
export const todoRoutes = {
  item(sessionId: string): string {
    return runBoundary(encodeTodoPathEffect(sessionId), "Invalid session-todo route", "encode")
  },
  override(sessionId: string): string {
    return runBoundary(
      encodeTodoOverridePathEffect(sessionId),
      "Invalid todo-override route",
      "encode"
    )
  }
} as const
