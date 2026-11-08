import type { IntelligenceSettings } from "@arden-hq/protocol/settings"
import { decodeIntelligenceSettingsPatchRequestEffect } from "@arden-hq/protocol/effect/settings"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

import { IntelligenceSettingsStore } from "../../persistence/settings/store.js"
import { ArdenApi } from "../api.js"
import { storeErrorToHttp } from "../errors.js"

const response = (settings: IntelligenceSettings) => ({
  assistant_name: settings.assistantName,
  max_agent_depth: settings.maxAgentDepth,
  max_concurrent_agents: settings.maxConcurrentAgents,
  max_concurrent_workers: settings.maxConcurrentWorkers,
  compaction_threshold: settings.compactionThreshold,
  compaction_keep_ratio: settings.compactionKeepRatio,
  summary_max_tokens: settings.summaryMaxTokens
})

export const IntelligenceSettingsHandlers = HttpApiBuilder.group(
  ArdenApi,
  "intelligenceSettings",
  Effect.fn(function* (handlers) {
    const store = yield* IntelligenceSettingsStore
    return handlers
      .handle("settings", () =>
        store.settings().pipe(
          Effect.map(response),
          Effect.mapError(() => new HttpApiError.InternalServerError({}))
        )
      )
      .handle("updateSettings", ({ payload }) =>
        Effect.gen(function* () {
          const patch = yield* decodeIntelligenceSettingsPatchRequestEffect(payload).pipe(
            Effect.mapError(() => new HttpApiError.BadRequest({}))
          )
          return response(yield* store.updateSettings(patch))
        }).pipe(
          Effect.catchTag("IntelligenceSettingsStoreError", (cause) =>
            Effect.fail(storeErrorToHttp(cause))
          )
        )
      )
  })
)
