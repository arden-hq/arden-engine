import { Effect } from "effect"
import { expect, it } from "vitest"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import { AutomationQueue } from "../src/persistence/automations/queue.js"
import { iso } from "../src/runtime/clock.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { LATER, claim, makeTask, tryRenew } from "./work-fixtures.js"

const seen = Effect.gen(function* () {
  const { queue } = yield* (yield* AutomationCatalog).diagnostics()
  return queue.map((row) => ({ held: row.held_by_worker_since, claimed: row.claimed_at }))
})

const one = <A>(leases: ReadonlyArray<A>): A => {
  const [lease] = leases
  if (lease === undefined) throw new Error("The Task was not claimed")
  return lease
}

it("a Task's hold start survives a renewal and its own reclaim, and ends with the hold", async () => {
  const T0 = LATER
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const queue = yield* AutomationQueue
      yield* makeTask
      const waiting = yield* seen
      const first = one(yield* claim("first", 10, T0))
      const claimed = yield* seen
      const renewal = yield* tryRenew(first, T0 + 1_000)
      if (renewal.kind === "refused") throw new Error(`Not renewed: ${renewal.message}`)
      const renewed = yield* seen
      const expiredAt = renewal.value.expiresAt + 1
      yield* Effect.promise(async () => queue.jobs.recoverExpired(expiredAt))
      const expired = yield* seen
      const second = one(yield* claim("second", 10, expiredAt))
      const reclaimed = yield* seen
      yield* Effect.promise(async () =>
        queue.jobs.release({ ...second, releasedAt: expiredAt + 1 })
      )
      const released = yield* seen
      const T3 = T0 + 10 * 60_000
      const third = one(yield* claim("third", 10, T3))
      const heldAgain = yield* seen
      yield* Effect.promise(async () =>
        queue.jobs.fail({ ...third, failedAt: T3 + 1_000, error: "Made-up", retryAt: T3 + 2_000 })
      )
      const retrying = yield* seen
      const T4 = T3 + 5_000
      const fourth = one(yield* claim("fourth", 10, T4))
      const afterRetry = yield* seen
      yield* Effect.promise(async () =>
        queue.jobs.complete({
          ...fourth,
          completedAt: T4 + 1_000,
          result: {
            status: "deferred",
            cause: "session_busy",
            reason: "Made-up",
            retryAt: T4 + 2_000,
            sessionId: null
          }
        })
      )
      const deferred = yield* seen
      const T5 = T4 + 5_000
      const fifth = one(yield* claim("fifth", 10, T5))
      const afterDeferral = yield* seen
      yield* Effect.promise(async () =>
        queue.jobs.complete({
          ...fifth,
          completedAt: T5 + 1_000,
          result: {
            status: "ended",
            outcome: "finished",
            result: "Done",
            error: null,
            chatRunId: null,
            chatSessionId: null
          }
        })
      )
      return {
        waiting,
        claimed,
        renewed,
        expired,
        reclaimed: [expiredAt, reclaimed] as const,
        released,
        heldAgain,
        retrying,
        afterRetry,
        deferred,
        afterDeferral,
        settled: yield* seen,
        sameAttempt: [second, third, fourth, fifth].map(
          (lease) => lease.payload.automationRunId === first.payload.automationRunId
        )
      }
    })
  )
  const T3 = T0 + 10 * 60_000
  const T4 = T3 + 5_000
  const T5 = T4 + 5_000
  const [expiredAt] = outcome.reclaimed
  expect(outcome).toEqual({
    waiting: [{ held: null, claimed: null }],
    claimed: [{ held: iso(T0), claimed: iso(T0) }],
    renewed: [{ held: iso(T0), claimed: iso(T0 + 1_000) }],
    expired: [{ held: iso(T0), claimed: iso(T0 + 1_000) }],
    reclaimed: [expiredAt, [{ held: iso(T0), claimed: iso(expiredAt) }]],
    released: [{ held: null, claimed: null }],
    heldAgain: [{ held: iso(T3), claimed: iso(T3) }],
    retrying: [{ held: null, claimed: null }],
    afterRetry: [{ held: iso(T4), claimed: iso(T4) }],
    deferred: [{ held: null, claimed: null }],
    afterDeferral: [{ held: iso(T5), claimed: iso(T5) }],
    settled: [],
    sameAttempt: [true, true, true, true]
  })
})
