import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import type { RelayStoreError } from "../../persistence/relay/store.js"
import { RelayService, type RelayServiceError } from "../../relay/service.js"
import { ArdenApi } from "../api.js"
import { failStore } from "../errors.js"

const serviceError = (
  error: RelayServiceError
): Effect.Effect<never, HttpApiError.NotFound | HttpApiError.ServiceUnavailable> => {
  switch (error.reason) {
    case "not_found":
      return Effect.fail(new HttpApiError.NotFound({}))
    case "unavailable":
      return Effect.fail(new HttpApiError.ServiceUnavailable({}))
  }
}

const storeError = (error: RelayStoreError) => failStore(error)

export const RelayHandlers = HttpApiBuilder.group(
  ArdenApi,
  "relay",
  Effect.fn(function* (handlers) {
    const relay = yield* RelayService
    return handlers
      .handle("status", () => relay.status().pipe(Effect.catchTag("RelayStoreError", storeError)))
      .handle("pair", () =>
        relay
          .pair()
          .pipe(
            Effect.catchTag("RelayServiceError", serviceError),
            Effect.catchTag("RelayStoreError", storeError)
          )
      )
      .handle("decide", ({ payload }) =>
        relay
          .decide(payload)
          .pipe(
            Effect.catchTag("RelayServiceError", serviceError),
            Effect.catchTag("RelayStoreError", storeError)
          )
      )
      .handle("remove", ({ params }) =>
        relay
          .remove(params.dev)
          .pipe(
            Effect.catchTag("RelayServiceError", serviceError),
            Effect.catchTag("RelayStoreError", storeError)
          )
      )
      .handle("settings", ({ payload }) =>
        relay.updateSettings(payload).pipe(Effect.catchTag("RelayStoreError", storeError))
      )
  })
)
