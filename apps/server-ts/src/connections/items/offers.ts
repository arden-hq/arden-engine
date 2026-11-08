import { Effect } from "effect"
import type { TaskProposalStore } from "../../persistence/proposals/store.js"

export const offerEach = (
  proposals: Pick<TaskProposalStore["Service"], "suggestFromItem">,
  routes: ReadonlyArray<{
    readonly itemId: string
    readonly offer: string
    readonly reason: string
  }>
): Effect.Effect<void> =>
  Effect.forEach(
    routes,
    (route) =>
      proposals
        .suggestFromItem({ itemId: route.itemId, text: route.offer, why: route.reason })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("A Home offer could not be made", { itemId: route.itemId, cause })
          )
        ),
    { discard: true }
  )
