import { Duration, Effect, Layer } from "effect"
import { timerSleep } from "../lib/timer-sleep.js"
import { TaskProposalStore } from "../persistence/proposals/store.js"

/** How often unanswered offers are checked against `OFFER_EXPIRY_HOURS`. An offer can stay
 * open this much past its age; nothing reads it more precisely. */
const EXPIRY_CHECK_EVERY = Duration.minutes(1)

/** Expires offers nobody answered in time and lets held Home offers move up. It starts no run
 * and sends no notice; Home and the Space board see the changed rows. */
export const OfferExpiryRuntime: Layer.Layer<never, never, TaskProposalStore> = Layer.effectDiscard(
  Effect.gen(function* () {
    const proposals = yield* TaskProposalStore
    yield* Effect.forkScoped(
      proposals.expireOffers().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not expire unanswered offers", cause)
        ),
        Effect.andThen(timerSleep(EXPIRY_CHECK_EVERY)),
        Effect.forever
      )
    )
  })
)
