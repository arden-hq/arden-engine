import { Effect, Predicate, Schema } from "effect"
import { HttpApiError } from "effect/unstable/httpapi"
import {
  STRUCTURED_COMPLETION_FAILURE,
  type StructuredCompletionError
} from "../models/structured-completion.js"
import { SpaceStoreError } from "../persistence/spaces/store.js"
import { STORE_REASON, type StoreReason } from "../persistence/errors.js"
import { SessionStoreError } from "../persistence/sessions/store.js"
import { ModelStoreError } from "../persistence/models/store.js"
import { WIKI_ERROR_REASON, type WikiError } from "../wiki/errors.js"

export class StoreConflict extends Schema.Error<StoreConflict>("StoreConflict")(
  { detail: Schema.optionalKey(Schema.String) },
  { httpApiStatus: 409 }
) {}

export class StoreInvalid extends Schema.Error<StoreInvalid>("StoreInvalid")(
  { detail: Schema.optionalKey(Schema.String) },
  { httpApiStatus: 422 }
) {}

export interface StoreReasonHttp {
  readonly invalid: StoreInvalid
  readonly not_found: HttpApiError.NotFound
  readonly conflict: StoreConflict
  readonly corrupt: HttpApiError.InternalServerError
  readonly unavailable: HttpApiError.ServiceUnavailable
  readonly storage: HttpApiError.InternalServerError
}

const statuses: {
  readonly [R in StoreReason]: (detail: string | undefined) => StoreReasonHttp[R]
} = {
  invalid: (detail) => new StoreInvalid(detail === undefined ? {} : { detail }),
  not_found: () => new HttpApiError.NotFound({}),
  conflict: (detail) => new StoreConflict(detail === undefined ? {} : { detail }),
  corrupt: () => new HttpApiError.InternalServerError({}),
  unavailable: () => new HttpApiError.ServiceUnavailable({}),
  storage: () => new HttpApiError.InternalServerError({})
}

export const storeErrors = [
  StoreInvalid,
  HttpApiError.NotFoundNoContent,
  StoreConflict,
  HttpApiError.ServiceUnavailableNoContent,
  HttpApiError.InternalServerErrorNoContent
] as const

export const storeErrorToHttp = <R extends StoreReason>(error: {
  readonly reason: R
  readonly message: string
}): StoreReasonHttp[R] => statuses[error.reason](ownerWorded(error) ? error.message : undefined)

const ownerWorded = (error: object): boolean =>
  error instanceof SessionStoreError ||
  error instanceof SpaceStoreError ||
  error instanceof ModelStoreError

interface StoreFailure<R extends StoreReason = StoreReason> {
  readonly reason: R
  readonly message?: string | undefined
  readonly operation?: string | undefined
  readonly cause?: unknown
}

const SERVER_SIDE_REASONS: ReadonlySet<StoreReason> = new Set([
  STORE_REASON.corrupt,
  STORE_REASON.storage,
  STORE_REASON.unavailable
])

export const logStoreFailure = (error: StoreFailure): Effect.Effect<void> =>
  SERVER_SIDE_REASONS.has(error.reason)
    ? Effect.logError("Store failure answered 5xx").pipe(
        Effect.annotateLogs({
          reason: error.reason,
          operation: error.operation ?? "unknown",
          message: error.message ?? "",
          cause: causeKind(error.cause)
        })
      )
    : Effect.void

export const failInternal =
  (what: string): ((error: unknown) => Effect.Effect<never, HttpApiError.InternalServerError>) =>
  (error: unknown): Effect.Effect<never, HttpApiError.InternalServerError> =>
    Effect.logError(`${what} answered 500`, error).pipe(
      Effect.andThen(Effect.fail(new HttpApiError.InternalServerError({})))
    )

export const failStore = <R extends StoreReason>(
  error: StoreFailure<R> & { readonly message: string }
): Effect.Effect<never, StoreReasonHttp[R]> =>
  logStoreFailure(error).pipe(Effect.andThen(Effect.fail(storeErrorToHttp(error))))

const causeKind = (cause: unknown): string => {
  if (!Predicate.isObject(cause)) return cause === undefined ? "none" : typeof cause
  if (Predicate.hasProperty(cause, "_tag") && Predicate.isString(cause._tag)) return cause._tag
  return cause instanceof Error ? cause.name : "object"
}

export const wikiErrorToHttp = (
  error: WikiError
):
  | StoreConflict
  | HttpApiError.ServiceUnavailable
  | StoreReasonHttp[Exclude<
      WikiError["reason"],
      typeof WIKI_ERROR_REASON.blocked | typeof WIKI_ERROR_REASON.closed
    >] => {
  if (error.reason === WIKI_ERROR_REASON.closed) return new HttpApiError.ServiceUnavailable({})
  return statuses[
    error.reason === WIKI_ERROR_REASON.blocked ? STORE_REASON.conflict : error.reason
  ](error.message)
}

export const orNotFound = <A>(
  value: A | null | undefined
): Effect.Effect<A, HttpApiError.NotFound> =>
  value === null || value === undefined
    ? Effect.fail(new HttpApiError.NotFound({}))
    : Effect.succeed(value)

export class OutputSchemaRejected extends Schema.Error<OutputSchemaRejected>(
  "OutputSchemaRejected"
)({ detail: Schema.String }, { httpApiStatus: 422 }) {}

export class CompletionUnavailable extends Schema.Error<CompletionUnavailable>(
  "CompletionUnavailable"
)({ detail: Schema.String }, { httpApiStatus: 503 }) {}

export class CompletionInvalidOutput extends Schema.Error<CompletionInvalidOutput>(
  "CompletionInvalidOutput"
)({ detail: Schema.String }, { httpApiStatus: 502 }) {}

export const completionErrors = [CompletionUnavailable, CompletionInvalidOutput] as const

export const completionErrorToHttp = (
  error: StructuredCompletionError
): CompletionUnavailable | CompletionInvalidOutput => {
  switch (error.reason) {
    case STRUCTURED_COMPLETION_FAILURE.unavailable:
    case STRUCTURED_COMPLETION_FAILURE.provider:
      return new CompletionUnavailable({ detail: error.message })
    case STRUCTURED_COMPLETION_FAILURE.invalid_output:
      return new CompletionInvalidOutput({ detail: error.message })
  }
}
