import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"

import { CommunicationStore } from "../../persistence/continuity/store.js"
import { ArdenApi } from "../api.js"
import { failStore } from "../errors.js"

export const ContinuityHandlers = HttpApiBuilder.group(
  ArdenApi,
  "continuity",
  Effect.fn("ContinuityHandlers")(function* (handlers) {
    const communication = yield* CommunicationStore
    return handlers
      .handle("state", ({ params }) =>
        communication.state(params.spaceId).pipe(Effect.catch(failStore))
      )
      .handle("acknowledge", ({ params, payload }) =>
        communication.acknowledge(params.spaceId, payload).pipe(Effect.catch(failStore))
      )
  })
)
