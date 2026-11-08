import { DateTime, Effect, Layer, Queue } from "effect"
import type { PowerHost } from "../../config/options.js"
import { GoogleConnections } from "../../google/service.js"
import { McpConnections } from "../../mcp/service.js"
import {
  CONNECTION_ITEM_KEEP_DAYS,
  ConnectionItemStore
} from "../../persistence/connections/store.js"
import { fetchGitHub, GITHUB_ACCOUNT } from "./github.js"
import { fetchGmail, hasReadyGmail } from "./gmail.js"

const FETCH_EVERY = "5 minutes"
const FIRST_FETCH_AFTER = "1 minute"
const AFTER_WAKE = "15 seconds"

export const connectionItemsRuntime = <R>(options: {
  readonly power: PowerHost | undefined
  readonly makeAfterFetch: Effect.Effect<Effect.Effect<void>, never, R>
}): Layer.Layer<never, never, R | ConnectionItemStore | GoogleConnections | McpConnections> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* ConnectionItemStore
      const google = yield* GoogleConnections
      const mcp = yield* McpConnections
      const afterFetch = yield* options.makeAfterFetch
      const wakes = yield* Queue.dropping<"wake">(1)
      const unsubscribe = options.power?.onSleep((asleep) => {
        if (!asleep) Queue.offerUnsafe(wakes, "wake")
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe?.()))

      const gmail = Effect.gen(function* () {
        const accounts = (yield* google.list()).accounts.filter(hasReadyGmail)
        for (const account of accounts) {
          yield* Effect.gen(function* () {
            const cursor = yield* store.cursor("gmail", account.id)
            const fetched = yield* fetchGmail({ google, store, account, cursor: cursor?.cursor })
            yield* store.saveFetch({
              source: "gmail",
              account: account.id,
              cursor: fetched.cursor,
              pollAfter: undefined,
              since: undefined,
              items: fetched.items
            })
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Gmail items could not be fetched", { account: account.id, cause })
            )
          )
        }
      })

      const github = Effect.gen(function* () {
        const token = yield* mcp.github.token()
        if (token === undefined) return
        const cursor = yield* store.cursor("github", GITHUB_ACCOUNT)
        const now = DateTime.formatIso(yield* DateTime.now)
        if (cursor?.pollAfter !== undefined && cursor.pollAfter > now) return
        const fetched = yield* fetchGitHub({ token, cursor: cursor?.cursor, since: cursor?.since })
        yield* store.saveFetch({
          source: "github",
          account: GITHUB_ACCOUNT,
          cursor: fetched.cursor,
          pollAfter: fetched.pollAfter,
          since: fetched.since,
          items: fetched.items
        })
      })

      const prune = Effect.gen(function* () {
        const before = DateTime.formatIso(
          DateTime.subtract(yield* DateTime.now, { days: CONNECTION_ITEM_KEEP_DAYS })
        )
        yield* store.prune(before)
      })

      const cycle = Effect.gen(function* () {
        yield* gmail.pipe(
          Effect.catchCause((cause) => Effect.logWarning("Gmail items fetch failed", cause))
        )
        yield* github.pipe(
          Effect.catchCause((cause) => Effect.logWarning("GitHub items fetch failed", cause))
        )
        yield* afterFetch
        yield* prune.pipe(
          Effect.catchCause((cause) => Effect.logWarning("Old items could not be removed", cause))
        )
      })

      const next = Queue.take(wakes).pipe(
        Effect.timeoutOption(FETCH_EVERY),
        Effect.flatMap((woken) => (woken._tag === "Some" ? Effect.sleep(AFTER_WAKE) : Effect.void))
      )

      yield* Effect.forkScoped(
        Effect.sleep(FIRST_FETCH_AFTER).pipe(
          Effect.andThen(cycle),
          Effect.andThen(next.pipe(Effect.andThen(cycle), Effect.forever))
        )
      )
    })
  )
