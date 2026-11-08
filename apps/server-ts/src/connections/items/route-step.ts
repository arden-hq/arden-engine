import { DateTime, Effect, Ref } from "effect"
import { StructuredCompletion } from "../../models/structured-completion.js"
import { ConnectionItemStore } from "../../persistence/connections/store.js"
import { TaskProposalStore } from "../../persistence/proposals/store.js"
import { SpaceStore } from "../../persistence/spaces/store.js"
import { WorkStore } from "../../persistence/work/store.js"
import { makeItemRouter } from "../../routing/items.js"
import { offerEach } from "./offers.js"

const MODEL_EVERY_MS = 15 * 60_000

export const makeRouteStep = Effect.gen(function* () {
  const route = makeItemRouter({
    spaces: yield* SpaceStore,
    work: yield* WorkStore,
    completion: yield* StructuredCompletion,
    store: yield* ConnectionItemStore
  })
  const proposals = yield* TaskProposalStore
  const lastModelAt = yield* Ref.make<number | undefined>(undefined)
  return Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now)
    const last = yield* Ref.get(lastModelAt)
    const pass = yield* route({ allowModel: last === undefined || now - last >= MODEL_EVERY_MS })
    if (pass.modelCalled) yield* Ref.set(lastModelAt, now)
    yield* offerEach(proposals, pass.offers)
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Connection items could not be routed", cause))
  )
})
