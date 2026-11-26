import { DECISION_SOURCE } from "@arden-hq/protocol/model-endpoints"
import { Context, type Effect } from "effect"

import type { EndpointFailureReason } from "../endpoints/failure.js"
import type { DecisionEndpoint } from "./endpoint.js"

export interface SelectedDecisionEndpoint {
  readonly origin: typeof DECISION_SOURCE.local | typeof DECISION_SOURCE.endpoint
  readonly endpoint: DecisionEndpoint
}

export class DecisionEndpointSource extends Context.Service<
  DecisionEndpointSource,
  {
    readonly current: () => Effect.Effect<SelectedDecisionEndpoint | undefined>
    readonly report: (
      selected: SelectedDecisionEndpoint,
      failure: EndpointFailureReason | undefined
    ) => Effect.Effect<void>
  }
>()("@arden-hq/server/models/decisions/DecisionEndpointSource") {}
