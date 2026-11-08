import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ArdenApi } from "../api.js"
import { ServerConfig } from "../../config/service.js"
import { ModelProviderService } from "../../models/provider.js"

export const HealthHandlers = HttpApiBuilder.group(
  ArdenApi,
  "health",
  Effect.fn(function* (handlers) {
    const config = yield* ServerConfig
    const models = yield* ModelProviderService

    return handlers.handle("health", () =>
      Effect.succeed({
        status: "ok" as const,
        version: config.version,
        has_providers: models.current() !== undefined
      })
    )
  })
)
