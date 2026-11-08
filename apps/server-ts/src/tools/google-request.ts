import { ToolExecutionError, type PauseRequested } from "@arden-hq/loop"
import type { GoogleAccount, GoogleServiceId } from "@arden-hq/protocol/google"
import { Effect, Option, Schema } from "effect"

import { GOOGLE_SERVICE_NAMES, googleConnectionPause } from "../google/recovery.js"
import type { GoogleConnectionError } from "../google/errors.js"
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
  if (error.reason === "provider" && error.diagnostic.kind === "http") return effects.failed()
  if (
    (error.reason === "provider" && error.diagnostic.kind === "transport") ||
    error.reason === "invalid_response"
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
    service === "calendar" &&
    error.diagnostic.kind === "http" &&
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
    case "auth_required":
    case "not_configured":
      return failure(`Connect ${names.label}`)
    case "access_denied":
      return failure("Account access denied")
    case "not_found":
      return failure(`Choose a ${names.account} account`)
    case "provider":
      switch (error.diagnostic.kind) {
        case "local":
          return failure(`${names.failure} unavailable`, true)
        case "transport":
          return failure(`${names.failure} network unavailable`, error.diagnostic.retryable)
        case "http":
          switch (error.diagnostic.reason) {
            case "rate_limit":
              return failure(`${names.failure} rate limited`, error.diagnostic.retryable)
            case "provider":
              return failure(`${names.failure} temporarily unavailable`, error.diagnostic.retryable)
            case "auth":
            case "request":
              return failure(`${names.failure} request rejected`)
          }
      }
    case "invalid_response":
      return failure(`Invalid ${names.failure} response`)
    case "storage":
      return failure(`${names.account} credentials unavailable`, true)
  }
}
