import { DateTime, Effect } from "effect"

import { MODEL_ENDPOINT_HEALTH, MODEL_ENDPOINT_RESULT } from "@arden-hq/protocol/model-endpoints"
import type { EndpointHealth } from "../../persistence/model-endpoints/store.js"
import { type EndpointFailureReason, runtimeFailure } from "./failure.js"

export const nextHealth = (
  health: EndpointHealth,
  failure: EndpointFailureReason | undefined
): Effect.Effect<EndpointHealth | undefined> => {
  if (failure === undefined)
    return Effect.succeed(
      health.state === MODEL_ENDPOINT_HEALTH.works ? undefined : { state: "works" }
    )
  const reason = runtimeFailure(failure)
  if (health.state === MODEL_ENDPOINT_HEALTH.failing && health.reason === reason)
    return Effect.succeed(undefined)
  return DateTime.now.pipe(
    Effect.map((now): EndpointHealth => ({
      state: "failing",
      reason,
      since: DateTime.formatIso(now),
      message:
        reason === MODEL_ENDPOINT_RESULT.keyRefused
          ? "The service refused the key"
          : "The endpoint stopped answering"
    }))
  )
}
