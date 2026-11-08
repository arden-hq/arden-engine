import { Context, Effect, Layer } from "effect"

import type { DecisionEndpoint } from "./endpoint.js"

export class LocalDecisionEndpoint extends Context.Service<
  LocalDecisionEndpoint,
  { readonly endpoint: () => Effect.Effect<DecisionEndpoint | undefined> }
>()("@arden-hq/server/models/decisions/LocalDecisionEndpoint") {
  static readonly none: Layer.Layer<LocalDecisionEndpoint> = Layer.succeed(
    LocalDecisionEndpoint,
    LocalDecisionEndpoint.of({ endpoint: () => Effect.succeed(undefined) })
  )
}
