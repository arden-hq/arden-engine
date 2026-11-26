import { ToolExecutionError, type PauseRequested } from "@arden-hq/loop"
import {
  GOOGLE_SERVICE_ID,
  type GoogleAccount,
  type GoogleServiceId
} from "@arden-hq/protocol/google"
import { Effect, Option, Schema } from "effect"

import { GOOGLE_SERVICE_NAMES, googleConnectionPause } from "../google/recovery.js"
import {
  GOOGLE_CONNECTION_REASON,
  GOOGLE_DIAGNOSTIC,
  GOOGLE_API_ERROR_REASON,
  type GoogleConnectionError
} from "../google/errors.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import type { CallEffects } from "../execution/tool-effect.js"

export const googleCall = async ({
  google,
  service,
  url,
  init = {},
  accountRef,
  signal,
  effects,
  response
}: {
  readonly google: GoogleToolConnections
  readonly service: GoogleServiceId
  readonly url: string
  readonly init?: RequestInit
  readonly accountRef: string | undefined
  readonly signal: AbortSignal
  readonly effects?: CallEffects
  readonly response?: { readonly kind: "binary"; readonly maxBytes: number }
}): Promise<{ readonly account: GoogleAccount; readonly value: unknown }> =>
  Effect.runPromise(
    google
      .request({
        service,
        url,
        init: { ...init, signal },
        accountRef,
        ...(response === undefined ? {} : { response })
      })
      .pipe(
        Effect.tap(() => Effect.sync(() => effects?.applied())),
        Effect.tapError((error) => Effect.sync(() => recordGoogleAnswer(effects, error))),
        Effect.mapError((error) => googleToolFailure(error, service, accountRef))
      ),
    { signal }
  )

export const recordGoogleAnswer = (
  effects: CallEffects | undefined,
  error: GoogleConnectionError
): void => {
  if (effects === undefined) return
  const provider = error.reason === GOOGLE_CONNECTION_REASON.provider
  if (provider && error.diagnostic.kind === GOOGLE_DIAGNOSTIC.http) return effects.failed()
  if (
    (provider && error.diagnostic.kind === GOOGLE_DIAGNOSTIC.transport) ||
    error.reason === GOOGLE_CONNECTION_REASON.invalidResponse
  ) {
    return effects.sent()
  }
}

export const decodeGoogle = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  { service, label }: { readonly service: GoogleServiceId; readonly label: string }
): ((value: unknown) => S["Type"]) => {
  const decode = Schema.decodeUnknownOption(schema)
  const names = GOOGLE_SERVICE_NAMES[service]
  return (value) =>
    Option.getOrThrowWith(
      decode(value),
      () =>
        new ToolExecutionError(`${names.label} returned an invalid ${label}.`, {
          preview: `Invalid ${names.failure} response`,
          retryable: false
        })
    )
}

export const googleToolFailure = (
  error: GoogleConnectionError,
  service: GoogleServiceId,
  accountRef: string | undefined
): ToolExecutionError | PauseRequested => {
  if (
    service === GOOGLE_SERVICE_ID.calendar &&
    error.diagnostic.kind === GOOGLE_DIAGNOSTIC.http &&
    error.diagnostic.status === 412
  ) {
    return new ToolExecutionError(
      "This Calendar event changed before the update reached Google. Read the event and request approval again; the update was not applied.",
      { preview: "Calendar event changed", retryable: false }
    )
  }
  const pause = googleConnectionPause(error, service, accountRef)
  if (pause !== undefined) return pause
  const names = GOOGLE_SERVICE_NAMES[service]
  const failure = (preview: string, retryable = false): ToolExecutionError =>
    new ToolExecutionError(error.message, { preview, retryable })
  switch (error.reason) {
    case GOOGLE_CONNECTION_REASON.authRequired:
    case GOOGLE_CONNECTION_REASON.notConfigured:
      return failure(`Connect ${names.label}`)
    case GOOGLE_CONNECTION_REASON.accessDenied:
      return failure("Account access denied")
    case GOOGLE_CONNECTION_REASON.notFound:
      return failure(`Choose a ${names.account} account`)
    case GOOGLE_CONNECTION_REASON.provider:
      switch (error.diagnostic.kind) {
        case GOOGLE_DIAGNOSTIC.local:
          return failure(`${names.failure} unavailable`, true)
        case GOOGLE_DIAGNOSTIC.transport:
          return failure(`${names.failure} network unavailable`, error.diagnostic.retryable)
        case GOOGLE_DIAGNOSTIC.http:
          switch (error.diagnostic.reason) {
            case GOOGLE_API_ERROR_REASON.rateLimit:
              return failure(`${names.failure} rate limited`, error.diagnostic.retryable)
            case GOOGLE_API_ERROR_REASON.provider:
              return failure(`${names.failure} temporarily unavailable`, error.diagnostic.retryable)
            case GOOGLE_API_ERROR_REASON.auth:
            case GOOGLE_API_ERROR_REASON.request:
              return failure(`${names.failure} request rejected`)
          }
      }
    case GOOGLE_CONNECTION_REASON.invalidResponse:
      return failure(`Invalid ${names.failure} response`)
    case GOOGLE_CONNECTION_REASON.storage:
      return failure(`${names.account} credentials unavailable`, true)
  }
}
