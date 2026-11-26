import { backoffDelayMs } from "@arden-hq/std/retry"
import { Cause, Clock, Duration, Effect, Queue, Semaphore } from "effect"
import {
  CHECKPOINT_MODE,
  type CheckpointMode,
  type StorageSessionStore,
  type StorageSessionStoreError
} from "../persistence/storage/session-store.js"

const MIB = 1_024 * 1_024

export interface FreeSpacePolicy {
  readonly startBytes: number
  readonly reserveBytes: number
  readonly batchBytes: number
  readonly passBatches: number
  readonly passMillis: number
}

export const freeSpacePolicy: FreeSpacePolicy = {
  startBytes: 256 * MIB,
  reserveBytes: 128 * MIB,
  batchBytes: 1 * MIB,
  passBatches: 8,
  passMillis: 250
}

const BATCH_GAP = "5 millis"
const ACTIVE_INTERVAL = Duration.seconds(2)
const IDLE_INTERVAL = Duration.seconds(60)
const CONTENDED_BACKOFF = { initialMs: 500, maxMs: Duration.toMillis(IDLE_INTERVAL) }
const FIRST_DELAY = Duration.minutes(2)

export interface FreeSpacePlan {
  readonly startPages: number
  readonly reservePages: number
  readonly batchPages: number
  readonly passBatches: number
  readonly passMillis: number
}

export const planPages = (policy: FreeSpacePolicy, pageSize: number): FreeSpacePlan => ({
  startPages: Math.ceil(policy.startBytes / pageSize),
  reservePages: Math.ceil(policy.reserveBytes / pageSize),
  batchPages: Math.max(1, Math.floor(policy.batchBytes / pageSize)),
  passBatches: policy.passBatches,
  passMillis: policy.passMillis
})

export const startsDrain = ({
  free,
  plan,
  trigger
}: {
  readonly free: number
  readonly plan: FreeSpacePlan
  readonly trigger: (typeof DRAIN_TRIGGER)[keyof typeof DRAIN_TRIGGER]
}): boolean =>
  free > plan.reservePages && (trigger === DRAIN_TRIGGER.requested || free >= plan.startPages)

const passContinues = ({
  batches,
  elapsedMillis,
  plan
}: {
  readonly batches: number
  readonly elapsedMillis: number
  readonly plan: FreeSpacePlan
}): boolean => batches < plan.passBatches && elapsedMillis < plan.passMillis

const PASS_END = { done: "done", yielded: "yielded", budget: "budget" } as const

export const DRAIN_TRIGGER = { schedule: "schedule", requested: "requested" } as const

const DRAIN_STATE = { idle: "idle", draining: "draining" } as const

const NO_CHECKPOINT = "none" as const

export interface PassResult {
  readonly end: (typeof PASS_END)[keyof typeof PASS_END]
  readonly released: number
}

export type DrainState =
  | { readonly kind: typeof DRAIN_STATE.idle }
  | { readonly kind: typeof DRAIN_STATE.draining; readonly stalls: number }

export interface NextStep {
  readonly state: DrainState
  readonly delay: Duration.Duration
  readonly checkpoint: CheckpointMode | "none"
}

const idle: DrainState = { kind: DRAIN_STATE.idle }

const afterPass = (state: DrainState, pass: PassResult): NextStep => {
  if (pass.end === PASS_END.done)
    return { state: idle, delay: IDLE_INTERVAL, checkpoint: CHECKPOINT_MODE.truncate }
  if (pass.end === PASS_END.yielded && pass.released === 0) {
    const stalls = state.kind === DRAIN_STATE.draining ? state.stalls + 1 : 1
    return {
      state: { kind: "draining", stalls },
      delay: Duration.millis(backoffDelayMs(CONTENDED_BACKOFF, stalls)),
      checkpoint: NO_CHECKPOINT
    }
  }
  return { state: { kind: "draining", stalls: 0 }, delay: ACTIVE_INTERVAL, checkpoint: "passive" }
}

type FreeSpaceStore = Pick<
  StorageSessionStore["Service"],
  "freePages" | "releaseFreePages" | "checkpoint" | "foregroundWork"
>

const runPass = Effect.fn("FreeSpace.pass")(function* (
  store: FreeSpaceStore,
  plan: FreeSpacePlan
): Effect.fn.Return<PassResult, StorageSessionStoreError> {
  const started = yield* Clock.currentTimeMillis
  let released = 0
  for (let batches = 0; ; batches += 1) {
    if (batches > 0) yield* Effect.sleep(BATCH_GAP)
    const elapsedMillis = (yield* Clock.currentTimeMillis) - started
    if (!passContinues({ batches, elapsedMillis, plan })) return { end: "budget", released }
    if (yield* store.foregroundWork()) return { end: "yielded", released }
    const batch = yield* store.releaseFreePages({
      pages: plan.batchPages,
      reservePages: plan.reservePages
    })
    released += batch.released
    if (batch.released === 0 || batch.free <= plan.reservePages) return { end: "done", released }
  }
})

interface FreeSpaceWorker {
  readonly loop: Effect.Effect<never>
  readonly drainNow: () => Effect.Effect<PassResult, StorageSessionStoreError>
}

export const makeFreeSpaceWorker = Effect.fn("FreeSpace.make")(function* (
  store: FreeSpaceStore,
  { policy = freeSpacePolicy }: { readonly policy?: FreeSpacePolicy } = {}
) {
  const lock = yield* Semaphore.make(1)
  const wake = yield* Queue.sliding<void>(1)

  const step = Effect.fn("FreeSpace.step")(function* (
    state: DrainState,
    trigger: (typeof DRAIN_TRIGGER)[keyof typeof DRAIN_TRIGGER]
  ): Effect.fn.Return<NextStep, StorageSessionStoreError> {
    const pages = yield* store.freePages()
    const plan = planPages(policy, pages.pageSize)
    if (state.kind === DRAIN_STATE.idle && !startsDrain({ free: pages.free, plan, trigger })) {
      return { state, delay: IDLE_INTERVAL, checkpoint: NO_CHECKPOINT }
    }
    const next = afterPass(state, yield* lock.withPermit(runPass(store, plan)))
    if (next.checkpoint !== NO_CHECKPOINT) yield* store.checkpoint(next.checkpoint)
    return next
  })

  const drainNow = Effect.fn("FreeSpace.drainNow")(function* () {
    const pages = yield* store.freePages()
    const plan = planPages(policy, pages.pageSize)
    const pass = yield* lock.withPermit(runPass(store, plan))
    const next = afterPass(idle, pass)
    if (next.checkpoint !== NO_CHECKPOINT) yield* store.checkpoint(next.checkpoint)
    if (pass.end !== PASS_END.done) yield* Queue.offer(wake, undefined)
    return pass
  })

  const loop = Effect.gen(function* () {
    let state: DrainState = idle
    let delay = FIRST_DELAY
    for (;;) {
      const trigger = yield* Effect.raceFirst(
        Effect.sleep(delay).pipe(Effect.as("schedule" as const)),
        Queue.take(wake).pipe(Effect.as("requested" as const))
      )
      const next: NextStep = yield* step(state, trigger).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not release free database space", {
            error: Cause.squash(cause)
          }).pipe(
            Effect.as<NextStep>({ state: idle, delay: IDLE_INTERVAL, checkpoint: NO_CHECKPOINT })
          )
        )
      )
      state = next.state
      delay = next.delay
    }
  })

  return { loop, drainNow } satisfies FreeSpaceWorker
})
