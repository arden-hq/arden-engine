import { Schema } from "effect"
import { STORE_REASON } from "../persistence/errors.js"
import type { ChatEventStoreError } from "../persistence/events/store.js"
import type { ContextCompactionStoreError } from "../persistence/compaction/store.js"
import type { ModelStoreError } from "../persistence/models/store.js"
import type { IntelligenceSettingsStoreError } from "../persistence/settings/store.js"

export const CONTEXT_COMPACTION_FAILURE = {
  invalid: "invalid",
  notFound: "not_found",
  conflict: "conflict",
  unavailable: "unavailable",
  provider: "provider",
  storage: "storage"
} as const

export const COMPACTION_OPERATION = {
  manual: "manual",
  automatic: "automatic",
  idle: "idle"
} as const

export type CompactionOperation = (typeof COMPACTION_OPERATION)[keyof typeof COMPACTION_OPERATION]

export class ContextCompactionError extends Schema.TaggedError<ContextCompactionError>()(
  "ContextCompactionError",
  {
    operation: Schema.Literals(Object.values(COMPACTION_OPERATION)),
    reason: Schema.Literals(Object.values(CONTEXT_COMPACTION_FAILURE)),
    message: Schema.String,
    sessionId: Schema.optionalKey(Schema.NonEmptyString),
    runId: Schema.optionalKey(Schema.NonEmptyString),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export const error = (
  operation: CompactionOperation,
  reason: ContextCompactionError["reason"],
  message: string,
  input?: { readonly sessionId?: string; readonly runId?: string; readonly cause?: unknown }
): ContextCompactionError =>
  new ContextCompactionError({
    operation,
    reason,
    message,
    ...(input?.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input?.runId === undefined ? {} : { runId: input.runId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause })
  })

export const mapStoreError = (
  operation: CompactionOperation,
  cause: ContextCompactionStoreError
): ContextCompactionError =>
  error(
    operation,
    cause.reason === STORE_REASON.corrupt ? STORE_REASON.storage : cause.reason,
    cause.message,
    {
      ...(cause.sessionId === undefined ? {} : { sessionId: cause.sessionId }),
      ...(cause.runId === undefined ? {} : { runId: cause.runId }),
      cause
    }
  )

export const mapModelError = (
  operation: CompactionOperation,
  sessionId: string,
  cause: ModelStoreError
): ContextCompactionError => {
  const reason =
    cause.reason === STORE_REASON.unavailable || cause.reason === STORE_REASON.storage
      ? cause.reason
      : STORE_REASON.invalid
  return error(operation, reason, cause.message, { sessionId, cause })
}

export const mapSettingsError = (
  operation: CompactionOperation,
  sessionId: string,
  cause: IntelligenceSettingsStoreError
): ContextCompactionError => error(operation, "storage", cause.message, { sessionId, cause })

export const mapEventError = (
  sessionId: string,
  runId: string,
  cause: ChatEventStoreError
): ContextCompactionError =>
  error("automatic", "storage", cause.message, {
    sessionId,
    runId,
    cause
  })
