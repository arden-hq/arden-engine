import { Effect, Schema } from "effect"
import { ChatWriteError, ChatWriteConflictError, type ChatWriteFailure } from "../chat/store.js"

export type ChatWriteOperation =
  | "start"
  | "drain"
  | "checkpoint"
  | "finish"
  | "fail"
  | "cancel"
  | "spawn_agent"
  | "fork_session"
  | "list_resumable"
  | "claim_resume"
  | "interrupt_stranded"
  | "enqueue"
  | "list_queued"
  | "reorder_queued"
  | "cancel_queued"
  | "due_queue_heads"
  | "fail_queued"

export const writeError = (
  operation: ChatWriteOperation,
  reason: "invalid" | "not_found" | "corrupt" | "storage" | "terminal",
  message: string,
  fields: { readonly sessionId?: string; readonly runId?: string; readonly cause?: unknown } = {}
): ChatWriteError =>
  new ChatWriteError({
    operation,
    reason,
    message,
    ...(fields.sessionId === undefined ? {} : { sessionId: fields.sessionId }),
    ...(fields.runId === undefined ? {} : { runId: fields.runId }),
    ...(fields.cause === undefined ? {} : { cause: fields.cause })
  })

export const mapFailure =
  (
    operation: ChatWriteOperation,
    fields: { readonly sessionId?: string; readonly runId?: string } = {}
  ): ((cause: unknown) => ChatWriteFailure) =>
  (cause: unknown): ChatWriteFailure =>
    cause instanceof ChatWriteError || cause instanceof ChatWriteConflictError
      ? cause
      : writeError(operation, "storage", "Could not complete chat write", { ...fields, cause })

export const validateInput = <S extends Schema.Constraint>(
  schema: S,
  input: unknown,
  operation: ChatWriteOperation
): Effect.Effect<S["Type"], ChatWriteError, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) =>
      writeError(operation, "invalid", "Invalid chat write input", { cause })
    )
  )
