import {
  DECISION_SOURCE,
  MODEL_ENDPOINT_HEALTH,
  type DecisionBackendState
} from "@arden-hq/protocol/model-endpoints"
import { Effect } from "effect"

import type { ModelEndpointSettings } from "../../persistence/model-endpoints/store.js"
import type { LocalDecisionEndpoint } from "../decisions/local.js"

export const decisionBackendState = Effect.fn("ModelEndpoints.backendState")(function* (
  current: ModelEndpointSettings,
  local: LocalDecisionEndpoint["Service"]
) {
  switch (current.decisionSource) {
    case DECISION_SOURCE.off:
      return { state: "off" } satisfies DecisionBackendState
    case DECISION_SOURCE.local: {
      const endpoint = yield* local.endpoint()
      return endpoint === undefined
        ? ({ state: "unavailable", reason: "no_local_model" } satisfies DecisionBackendState)
        : ({
            state: "ready",
            model: endpoint.model,
            input: endpoint.input
          } satisfies DecisionBackendState)
    }
    case DECISION_SOURCE.endpoint: {
      const stored = current.decision
      if (stored === null)
        return { state: "unavailable", reason: "no_endpoint" } satisfies DecisionBackendState
      return stored.health.state === MODEL_ENDPOINT_HEALTH.failing
        ? ({
            state: "failing",
            model: stored.model,
            input: stored.input,
            reason: stored.health.reason,
            since: stored.health.since
          } satisfies DecisionBackendState)
        : ({
            state: "ready",
            model: stored.model,
            input: stored.input
          } satisfies DecisionBackendState)
    }
  }
})
