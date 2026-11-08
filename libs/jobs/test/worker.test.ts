import { Clock, Effect, Queue } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import {
  JobLeaseLostError,
  makeJobWorker,
  type JobDriver,
  type JobLease,
  type JobWorker
} from "../src/index.js"

interface Payload {
  readonly value: string
}

const lease = (attempt = 1): JobLease<Payload> => ({
  id: "job-1",
  token: "lease-1",
  attempt,
  payload: { value: "work" },
  leasedAt: 0,
  expiresAt: 100
})

const driver = (
  overrides: Partial<JobDriver<Payload, string>> = {}
): JobDriver<Payload, string> => ({
  recoverExpired: async () => 0,
  claim: async () => [],
  renew: async () => lease(),
  complete: async () => {},
  fail: async () => {},
  release: async () => {},
  nextDueAt: async () => undefined,
  ...overrides
})

const gate = () => {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("job worker", () => {
  it("recovers, claims, executes, and settles through the durable driver", async () => {
    const calls: string[] = []
    const worker = makeJobWorker({
      now: () => Date.now(),
      driver: driver({
        recoverExpired: async () => {
          calls.push("recover")
          return 1
        },
        claim: async () => {
          calls.push("claim")
          return [lease()]
        },
        complete: async ({ result }) => {
          calls.push(`complete:${result}`)
        }
      }),
      execute: async (job) => {
        calls.push(`execute:${job.payload.value}`)
        return "done"
      },
      workerId: "test-worker",
      leaseDurationMs: 1_000
    })

    expect(await worker.runOnce()).toBe(1)
    expect(calls).toEqual(["recover", "claim", "execute:work", "complete:done"])
  })

  it("records a bounded retry and makes the last attempt terminal", async () => {
    const retries: Array<number | null> = []
    let current = lease(1)
    const worker = makeJobWorker({
      driver: driver({
        claim: async () => [current],
        fail: async ({ retryAt }) => {
          retries.push(retryAt)
        }
      }),
      execute: async () => {
        throw new Error("broken")
      },
      now: () => 10,
      maxAttempts: 2,
      retryDelayMs: () => 5,
      onError: () => {},
      leaseDurationMs: 1_000
    })

    await worker.runOnce()
    current = lease(2)
    await worker.runOnce()
    expect(retries).toEqual([15, null])
  })

  it("counts a refused settlement as a failed attempt with backoff, not an instant re-run", async () => {
    const retries: Array<number | null> = []
    let released = 0
    let current = lease(1)
    const worker = makeJobWorker({
      driver: driver({
        claim: async () => [current],
        complete: async () => {
          throw new Error("store refused the result")
        },
        fail: async ({ retryAt }) => {
          retries.push(retryAt)
        },
        release: async () => {
          released += 1
        }
      }),
      execute: async () => "done",
      now: () => 10,
      maxAttempts: 2,
      retryDelayMs: () => 5,
      onError: () => {},
      leaseDurationMs: 1_000
    })

    await worker.runOnce()
    current = lease(2)
    await worker.runOnce()
    expect(retries).toEqual([15, null])
    expect(released).toBe(0)
  })

  it("does not settle after renewal loses the lease", async () => {
    let completed = false
    const execution = gate()
    const worker = makeJobWorker({
      now: () => Date.now(),
      driver: driver({
        claim: async () => [lease()],
        renew: async () => {
          throw new JobLeaseLostError("job-1")
        },
        complete: async () => {
          completed = true
        }
      }),
      execute: async (_job, { signal }) => {
        await Promise.race([
          execution.promise,
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          )
        ])
        execution.resolve()
        return "done"
      },
      leaseDurationMs: 4,
      onError: () => {}
    })

    await worker.runOnce()
    expect(completed).toBe(false)
  })
})

describe("job worker settlement safety", () => {
  it("quiesces claims while active jobs renew their lease and settle", async () => {
    const started = gate()
    const finish = gate()
    const tick = gate()
    const renewed = gate()
    const events: string[] = []
    let firstSleep = true
    let aborted = false
    const worker = makeJobWorker({
      now: () => 0,
      driver: driver({
        claim: async () => {
          events.push("claim")
          return [lease()]
        },
        renew: async () => {
          events.push("renew")
          renewed.resolve()
          return lease()
        },
        complete: async () => {
          events.push("complete")
        }
      }),
      execute: async (_job, { signal }) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true
          },
          { once: true }
        )
        started.resolve()
        await finish.promise
        return "done"
      },
      sleep: async (_duration, signal) => {
        if (firstSleep) {
          firstSleep = false
          await tick.promise
          return
        }
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        )
      }
    })
    const running = worker.runOnce()
    await started.promise
    worker.quiesce()
    const newAdmissions = await worker.runOnce()
    tick.resolve()
    await renewed.promise
    expect({ newAdmissions, aborted }).toEqual({ newAdmissions: 0, aborted: false })
    finish.resolve()
    await running
    expect(events).toEqual(["claim", "renew", "complete"])
  })

  it("hands back a lease whose claim crosses quiescence without executing it", async () => {
    const claiming = gate()
    const deliver = gate()
    const events: string[] = []
    const worker = makeJobWorker({
      now: () => 0,
      driver: driver({
        claim: async () => {
          claiming.resolve()
          await deliver.promise
          return [lease()]
        },
        release: async () => {
          events.push("release")
        }
      }),
      execute: async () => {
        events.push("execute")
        return "done"
      }
    })
    const running = worker.runOnce()
    await claiming.promise
    worker.quiesce()
    deliver.resolve()
    await running
    expect(events).toEqual(["release"])
    expect(await worker.runOnce()).toBe(0)
  })

  it("waits for active jobs to release their leases before stop resolves", async () => {
    const aborted = gate()
    const cleanup = gate()
    const released: string[] = []
    let claimed = false
    const worker = makeJobWorker({
      now: () => Date.now(),
      driver: driver({
        claim: async () => {
          if (claimed) return []
          claimed = true
          return [lease()]
        },
        release: async ({ id }) => {
          released.push(id)
        }
      }),
      execute: async (_job, { signal }) => {
        signal.addEventListener("abort", aborted.resolve, { once: true })
        await cleanup.promise
        return "done"
      }
    })
    worker.start()
    await expect.poll(() => claimed).toBe(true)
    let stopped = false
    const stopping = worker.stop().then(() => {
      stopped = true
    })
    try {
      await aborted.promise
      expect(stopped).toBe(false)
    } finally {
      cleanup.resolve()
      await stopping
    }
    expect(released).toEqual(["job-1"])
  })
})

const timedWorker = Effect.fn(function* (options: {
  readonly nextDueAt: (now: number) => number | undefined
  readonly holdClaim: () => Promise<void>
}): Effect.fn.Return<{ readonly worker: JobWorker; readonly next: Effect.Effect<string> }> {
  const context = yield* Effect.context<never>()
  const events = yield* Queue.unbounded<string>()
  const now = () => Effect.runSyncWith(context)(Clock.currentTimeMillis)
  const record = (event: string) => Effect.runSync(Queue.offer(events, `${event}@${now()}`))
  const worker = makeJobWorker({
    driver: driver({
      claim: async () => {
        record("claim")
        await options.holdClaim()
        return []
      },
      nextDueAt: async (now) => options.nextDueAt(now)
    }),
    execute: async () => "done",
    now,
    sleep: (durationMs, signal) => {
      record(`sleep ${durationMs}`)
      return Effect.runPromiseWith(context)(Effect.sleep(durationMs), { signal })
    }
  })
  return { worker, next: Queue.take(events) }
})

const onTestClock = <A>(test: Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(test.pipe(Effect.provide(TestClock.layer())))

const nothingDue = (): undefined => undefined
const noHold = async (): Promise<void> => {}

describe("job worker wakes", () => {
  it("admits again at once for a wake that lands while it is claiming", () =>
    onTestClock(
      Effect.gen(function* () {
        const release = gate()
        let held = false
        const { worker, next } = yield* timedWorker({
          nextDueAt: nothingDue,
          holdClaim: async () => {
            if (held) return
            held = true
            await release.promise
          }
        })
        worker.start()
        const claiming = yield* next
        worker.wake()
        release.resolve()
        const events = [claiming, yield* next, yield* next]
        yield* Effect.promise(() => worker.stop())
        expect(events).toEqual(["claim@0", "claim@0", "sleep 60000@0"])
      })
    ))

  it("admits at once on a wake while it sleeps", () =>
    onTestClock(
      Effect.gen(function* () {
        const { worker, next } = yield* timedWorker({ nextDueAt: nothingDue, holdClaim: noHold })
        worker.start()
        const idle = [yield* next, yield* next]
        worker.wake()
        const woken = [yield* next, yield* next]
        yield* Effect.promise(() => worker.stop())
        expect([...idle, ...woken]).toEqual([
          "claim@0",
          "sleep 60000@0",
          "claim@0",
          "sleep 60000@0"
        ])
      })
    ))

  it("sleeps until the earliest due time, then admits", () =>
    onTestClock(
      Effect.gen(function* () {
        const { worker, next } = yield* timedWorker({
          nextDueAt: (now) => (now < 5_000 ? 5_000 : undefined),
          holdClaim: noHold
        })
        worker.start()
        const idle = [yield* next, yield* next]
        yield* TestClock.adjust(5_000)
        const due = yield* next
        yield* Effect.promise(() => worker.stop())
        expect([...idle, due]).toEqual(["claim@0", "sleep 5000@0", "claim@5000"])
      })
    ))

  it("re-arms for an earlier due time after a wake", () =>
    onTestClock(
      Effect.gen(function* () {
        let due = 30_000
        const { worker, next } = yield* timedWorker({
          nextDueAt: (now) => (now < due ? due : undefined),
          holdClaim: noHold
        })
        worker.start()
        const first = [yield* next, yield* next]
        due = 2_000
        worker.wake()
        const rearmed = [yield* next, yield* next]
        yield* TestClock.adjust(2_000)
        const fired = yield* next
        yield* Effect.promise(() => worker.stop())
        expect([...first, ...rearmed, fired]).toEqual([
          "claim@0",
          "sleep 30000@0",
          "claim@0",
          "sleep 2000@0",
          "claim@2000"
        ])
      })
    ))

  it("admits once per idle timeout when nothing is due", () =>
    onTestClock(
      Effect.gen(function* () {
        const { worker, next } = yield* timedWorker({ nextDueAt: nothingDue, holdClaim: noHold })
        worker.start()
        const first = [yield* next, yield* next]
        yield* TestClock.adjust(60_000)
        const second = [yield* next, yield* next]
        yield* Effect.promise(() => worker.stop())
        expect([...first, ...second]).toEqual([
          "claim@0",
          "sleep 60000@0",
          "claim@60000",
          "sleep 60000@60000"
        ])
      })
    ))
})
