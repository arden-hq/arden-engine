import {
  decodeLimitSettingsPatchRequestEffect,
  limitSettingsResponse
} from "@arden-hq/protocol/effect/settings"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

import { LimitSettingsStore } from "../../persistence/settings/store.js"
import { ArdenApi } from "../api.js"
import { storeErrorToHttp } from "../errors.js"

export const LimitSettingsHandlers = HttpApiBuilder.group(
  ArdenApi,
  "limitSettings",
  Effect.fn(function* (handlers) {
    const store = yield* LimitSettingsStore
    return handlers
      .handle("settings", () =>
        store.settings().pipe(
          Effect.map(limitSettingsResponse),
          Effect.mapError(() => new HttpApiError.InternalServerError({}))
        )
      )
      .handle("updateSettings", ({ payload }) =>
        Effect.gen(function* () {
          const patch = yield* decodeLimitSettingsPatchRequestEffect(payload).pipe(
            Effect.mapError(() => new HttpApiError.BadRequest({}))
          )
          return limitSettingsResponse(yield* store.updateSettings(patch))
        }).pipe(
          Effect.catchTag("LimitSettingsStoreError", (cause) =>
            Effect.fail(storeErrorToHttp(cause))
          )
        )
      )
  })
)
