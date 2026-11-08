import { errorMessage, redactedFailureText } from "@arden-hq/std/errors"
import { backoffDelayMs } from "@arden-hq/std/retry"
import { sleep as stdSleep } from "@arden-hq/std/sleep"
export type MaybePromise<A> = A | PromiseLike<A>

export interface JobLease<Payload> {
  readonly id: string
  readonly token: string
  readonly attempt: number
  readonly payload: Payload
  readonly leasedAt: number
  readonly expiresAt: number
}

export interface JobLeaseRef {
  readonly id: string
  readonly token: string
}

export interface JobClaimInput {
  readonly workerId: string
  readonly limit: number
  readonly now: number
  readonly leaseDurationMs: number
}

export interface JobRenewInput extends JobLeaseRef {
  readonly workerId: string
  readonly now: number
  readonly leaseDurationMs: number
}

export interface JobCompleteInput<Result> extends JobLeaseRef {
  readonly completedAt: number
  readonly result: Result
}

export interface JobFailInput extends JobLeaseRef {
  readonly failedAt: number
  readonly error: string
  /** Null is terminal. */
  readonly retryAt: number | null
}

export interface JobReleaseInput extends JobLeaseRef {
  readonly releasedAt: number
}

/** Durable consumer seam. Every mutation after claim must fence on token. */
export interface JobDriver<Payload, Result> {
  recoverExpired(now: number): MaybePromise<number>
  claim(input: JobClaimInput): MaybePromise<ReadonlyArray<JobLease<Payload>>>
  renew(input: JobRenewInput): MaybePromise<JobLease<Payload>>
  complete(input: JobCompleteInput<Result>): MaybePromise<void>
  fail(input: JobFailInput): MaybePromise<void>
  release(input: JobReleaseInput): MaybePromise<void>
  /** The earliest instant strictly after `now` at which a job that is not
   *  claimable now becomes claimable by time alone (a retry, a schedule, a
   *  hold); undefined when no job waits on time. Early is harmless, late
   *  delays the job until the next wake. */
  nextDueAt(now: number): MaybePromise<number | undefined>
}

export interface JobExecutionContext {
  readonly signal: AbortSignal
}

export type JobExecutor<Payload, Result> = (
  job: JobLease<Payload>,
  context: JobExecutionContext
) => MaybePromise<Result>

export class JobLeaseLostError extends Error {
  override readonly name = "JobLeaseLostError"
  readonly jobId: string

  constructor(jobId: string) {
    super(`Lease lost for job ${jobId}`)
    this.jobId = jobId
  }
}

export interface JobWorkerOptions<Payload, Result> {
  readonly driver: JobDriver<Payload, Result>
  readonly execute: JobExecutor<Payload, Result>
  readonly workerId?: string
  /** A live resolver is read before each claim, including when all slots are occupied. */
  readonly concurrency?: number | (() => MaybePromise<number>)
  /** The longest the worker sleeps between admissions, and the bound on how
   *  late work can start when a wake is missed, the clock jumps, or the host
   *  sleeps through a timer (macOS timers do not advance while asleep). */
  readonly idleTimeoutMs?: number
  readonly leaseDurationMs?: number
  readonly maxAttempts?: number
  readonly retryDelayMs?: (attempt: number) => number
  /** The host's clock. No default: a worker that reads the machine's time disagrees with
   *  the host's stored times, so the host names its clock. */
  readonly now: () => number
  /** Resolves after `durationMs`, rejects once `signal` aborts. */
  readonly sleep?: (durationMs: number, signal: AbortSignal) => Promise<void>
  readonly onError?: (error: unknown) => MaybePromise<void>
}

export interface JobWorkerSnapshot {
  readonly running: boolean
  readonly activeCount: number
  readonly capacity: number | undefined
  readonly lastAdmitAt: number | undefined
  readonly lastClaimAt: number | undefined
  /** When the idle worker admits again without a wake; undefined while it works. */
  readonly nextWakeAt: number | undefined
  readonly activeJobIds: ReadonlyArray<string>
}

export interface JobWorker {
  readonly workerId: string
  readonly running: boolean
  snapshot(): JobWorkerSnapshot
  start(): void
  /** Refuse new claims while active executions keep their leases and settle. */
  quiesce(): void
  stop(): Promise<void>
  wake(): void
  runOnce(): Promise<number>
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000
const ADMIT_RETRY_MS = 1_000
const DEFAULT_LEASE_DURATION_MS = 30_000
const DEFAULT_MAX_ATTEMPTS = 5

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
  return value
}

const failureText = (cause: unknown): string =>
  redactedFailureText(
    cause instanceof Error ? `${cause.name}: ${cause.message}` : errorMessage(cause)
  ) || "Job execution failed"

const abortError = (): DOMException => new DOMException("The job was cancelled", "AbortError")

const defaultRetryDelay = (attempt: number): number =>
  backoffDelayMs({ initialMs: 1_000, maxMs: 60_000 }, attempt)

/** Make one in-process worker around a durable driver. */
export const makeJobWorker = <Payload, Result>(
  options: JobWorkerOptions<Payload, Result>
): JobWorker => {
  const concurrency = options.concurrency ?? 1
  if (typeof concurrency === "number") positiveInteger(concurrency, "concurrency")
  const idleTimeoutMs = positiveInteger(
    options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    "idleTimeoutMs"
  )
  const leaseDurationMs = positiveInteger(
    options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
    "leaseDurationMs"
  )
  const maxAttempts = positiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, "maxAttempts")
  const workerId = options.workerId?.trim() || globalThis.crypto.randomUUID()
  const now = options.now
  const sleep = options.sleep ?? stdSleep
  const retryDelay = options.retryDelayMs ?? defaultRetryDelay
  const active = new Map<string, { controller: AbortController; lease: JobLease<Payload> }>()
  const pending = new Set<Promise<void>>()
  let capacity: number | undefined
  let lastAdmitAt: number | undefined
  let lastClaimAt: number | undefined
  let nextWakeAt: number | undefined
  let claiming: Promise<ReadonlyArray<Promise<void>>> | undefined
  let loop: Promise<void> | undefined
  let stopping = false
  let accepting = true
  let recovered = false
  let wakeRequested = false
  let interruptIdle: (() => void) | undefined

  const reportSafely = async (cause: unknown): Promise<void> => {
    try {
      await options.onError?.(cause)
    } catch {}
  }

  const recover = async (): Promise<void> => {
    if (recovered) return
    await options.driver.recoverExpired(now())
    recovered = true
  }

  const renewUntilDone = async (
    key: string,
    state: { controller: AbortController; lease: JobLease<Payload> }
  ): Promise<void> => {
    const interval = Math.max(1, Math.floor(leaseDurationMs / 2))
    while (!state.controller.signal.aborted) {
      try {
        await sleep(interval, state.controller.signal)
      } catch {
        return
      }
      if (state.controller.signal.aborted) return
      try {
        state.lease = await options.driver.renew({
          id: state.lease.id,
          token: state.lease.token,
          workerId,
          now: now(),
          leaseDurationMs
        })
      } catch (cause) {
        state.controller.abort(cause)
        await reportSafely(cause)
        return
      }
      active.set(key, state)
    }
  }

  const nextRetryAt = async (attempt: number): Promise<number | null> => {
    if (attempt >= maxAttempts) return null
    let delay: number
    try {
      delay = retryDelay(attempt)
    } catch (delayCause) {
      await reportSafely(delayCause)
      delay = defaultRetryDelay(attempt)
    }
    return (
      now() +
      (Number.isFinite(delay) && delay >= 0 ? Math.floor(delay) : defaultRetryDelay(attempt))
    )
  }

  const process = async (initial: JobLease<Payload>): Promise<void> => {
    const releaseLease = async (lease: JobLeaseRef): Promise<void> => {
      try {
        await options.driver.release({
          id: lease.id,
          token: lease.token,
          releasedAt: now()
        })
      } catch (releaseCause) {
        await reportSafely(releaseCause)
      }
    }
    if (stopping || !accepting) {
      await releaseLease(initial)
      return
    }
    const controller = new AbortController()
    const key = `${initial.id}\0${initial.token}`
    const state = { controller, lease: initial }
    const failAttemptWithBackoff = async (cause: unknown): Promise<void> => {
      try {
        await options.driver.fail({
          id: state.lease.id,
          token: state.lease.token,
          failedAt: now(),
          error: failureText(cause),
          retryAt: await nextRetryAt(initial.attempt)
        })
      } catch (failureCause) {
        await reportSafely(failureCause)
      }
    }
    active.set(key, state)
    const renewal = renewUntilDone(key, state)
    try {
      let result: Result
      try {
        result = await options.execute(initial, { signal: controller.signal })
        if (controller.signal.aborted) {
          throw controller.signal.reason ?? new JobLeaseLostError(initial.id)
        }
      } catch (cause) {
        if (stopping) {
          await releaseLease(state.lease)
        } else if (!(cause instanceof JobLeaseLostError) && !controller.signal.aborted) {
          await failAttemptWithBackoff(cause)
        }
        if (!stopping) await reportSafely(cause)
        return
      }
      try {
        await options.driver.complete({
          id: state.lease.id,
          token: state.lease.token,
          completedAt: now(),
          result
        })
      } catch (settleCause) {
        await reportSafely(settleCause)
        await failAttemptWithBackoff(settleCause)
      }
    } finally {
      controller.abort()
      await renewal
      active.delete(key)
    }
  }

  const claimAvailable = async (): Promise<ReadonlyArray<Promise<void>>> => {
    if (!accepting) return []
    await recover()
    lastAdmitAt = now()
    capacity =
      typeof concurrency === "number"
        ? concurrency
        : positiveInteger(await concurrency(), "concurrency")
    const limit = capacity - pending.size
    if (stopping || !accepting || limit <= 0) return []
    const leases = await options.driver.claim({
      workerId,
      limit,
      now: now(),
      leaseDurationMs
    })
    lastClaimAt = now()
    return leases.map((lease) => {
      const execution = process(lease)
        .catch(reportSafely)
        .finally(() => {
          pending.delete(execution)
          wake()
        })
      pending.add(execution)
      return execution
    })
  }

  const admit = (): Promise<ReadonlyArray<Promise<void>>> => {
    claiming ??= claimAvailable().finally(() => {
      claiming = undefined
    })
    return claiming
  }

  const runOnce = async (): Promise<number> => {
    if (!accepting) return 0
    const executions = await admit()
    await Promise.all(executions)
    return executions.length
  }

  function wake(): void {
    wakeRequested = true
    interruptIdle?.()
  }

  const admitThenIdleDelay = async (): Promise<number | undefined> => {
    if (!accepting) return idleTimeoutMs
    const executions = await admit()
    if (executions.length > 0) return undefined
    const at = now()
    const due = await options.driver.nextDueAt(at)
    return due === undefined || due <= at
      ? idleTimeoutMs
      : Math.min(idleTimeoutMs, Math.max(0, due - now()))
  }

  const idle = async (durationMs: number): Promise<void> => {
    if (stopping || wakeRequested) return
    const controller = new AbortController()
    interruptIdle = () => controller.abort()
    nextWakeAt = now() + durationMs
    try {
      await sleep(durationMs, controller.signal)
    } catch {
    } finally {
      interruptIdle = undefined
      nextWakeAt = undefined
    }
  }

  const run = async (): Promise<void> => {
    try {
      while (!stopping) {
        wakeRequested = false
        const delay = await admitThenIdleDelay().catch(async (cause: unknown) => {
          await reportSafely(cause)
          return Math.min(ADMIT_RETRY_MS, idleTimeoutMs)
        })
        if (delay !== undefined) await idle(delay)
      }
    } finally {
      for (const state of active.values()) state.controller.abort(abortError())
      await Promise.allSettled(pending)
    }
  }

  return {
    workerId,
    get running() {
      return loop !== undefined && !stopping && accepting
    },
    snapshot: () => ({
      running: loop !== undefined && !stopping && accepting,
      activeCount: pending.size,
      capacity,
      lastAdmitAt,
      lastClaimAt,
      nextWakeAt,
      activeJobIds: [...active.values()].map(({ lease }) => lease.id)
    }),
    start() {
      if (loop !== undefined) return
      stopping = false
      accepting = true
      loop = run()
    },
    quiesce() {
      accepting = false
      interruptIdle?.()
    },
    async stop() {
      const current = loop
      if (current === undefined) return
      stopping = true
      interruptIdle?.()
      for (const state of active.values()) state.controller.abort(abortError())
      await current
      if (loop === current) loop = undefined
    },
    wake,
    runOnce
  }
}
