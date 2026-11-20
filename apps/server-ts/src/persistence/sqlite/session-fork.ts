import { Effect, Schema } from "effect"
import { SessionForkOriginSchema } from "@arden-hq/protocol/effect/common"
import type { SessionForkOrigin } from "@arden-hq/protocol/sessions"

import type { ChatWriteError } from "../chat/store.js"
import type { JsonObject } from "../json.js"
import { StoredMessageEnvelopeSchema, type StoredMessageEnvelope } from "../transcript/model.js"
import { writeError } from "./chat-write-errors.js"

export const prepareForkContext = Effect.fn("SessionFork.prepareContext")(function* (input: {
  readonly history: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly parentSessionId: string
  readonly forkId: string
  readonly closeOpenCall: (callId: string) => string
  readonly timestamp: string
  readonly operation: "spawn_agent" | "fork_session"
  readonly presentation: "preserve" | "inherited"
}): Effect.fn.Return<ReadonlyArray<StoredMessageEnvelope>, ChatWriteError> {
  const kept = input.history.filter((message) => message.role !== "system")
  const completedToolCalls = new Set(
    kept.flatMap((message) =>
      message.role === "tool" &&
      message.async_tool_launch === undefined &&
      typeof message.tool_call_id === "string"
        ? [message.tool_call_id]
        : []
    )
  )
  const open = kept.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return []
    return message.tool_calls.flatMap((call: unknown) => {
      const id = typeof call === "object" && call !== null && "id" in call ? call.id : undefined
      return typeof id === "string" && !completedToolCalls.has(id) ? [id] : []
    })
  })
  const closing = open.map((id): Readonly<Record<string, unknown>> => ({
    message_id: `fork-close:${id}`,
    role: "tool",
    tool_call_id: id,
    content: input.closeOpenCall(id)
  }))
  return yield* Effect.forEach([...kept, ...closing], (message, index) => {
    const { turn_id: _turn, ...fields } = message
    return Schema.decodeUnknownEffect(StoredMessageEnvelopeSchema)({
      ...fields,
      message_id:
        typeof fields.message_id === "string" && fields.message_id.length > 0
          ? fields.message_id
          : `fork:${input.forkId}:${index}`,
      created_at: typeof fields.created_at === "string" ? fields.created_at : input.timestamp,
      ...(input.presentation === "inherited" ? { forked_from: input.parentSessionId } : {})
    }).pipe(
      Effect.mapError((cause) =>
        writeError(input.operation, "invalid", "The parent's history cannot be forked", {
          sessionId: input.parentSessionId,
          cause
        })
      )
    )
  })
})

export const makeSessionForkOrigin = Effect.fn("SessionFork.makeOrigin")(function* (input: {
  readonly sourceSessionId: string
  readonly sourceSessionRef: string | null
  readonly throughSequence: number
  readonly sourceMessageId: string | null
  readonly createdAt: string
}): Effect.fn.Return<SessionForkOrigin, Error> {
  return yield* Schema.decodeUnknownEffect(SessionForkOriginSchema)(input).pipe(
    Effect.mapError((cause) => new Error("Fork origin is invalid", { cause }))
  )
})

export const sessionForkOriginMetadata = (origin: SessionForkOrigin): JsonObject => ({
  sourceSessionId: origin.sourceSessionId,
  sourceSessionRef: origin.sourceSessionRef,
  throughSequence: origin.throughSequence,
  sourceMessageId: origin.sourceMessageId,
  createdAt: origin.createdAt
})
