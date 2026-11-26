import { ToolExecutionError } from "@arden-hq/loop"
import { isFulfilled } from "@arden-hq/std/attempt"

const CONCURRENCY = 4

export const inBatches = async <A, B>(
  values: ReadonlyArray<A>,
  operation: (value: A) => Promise<B>,
  signal: AbortSignal
): Promise<ReadonlyArray<PromiseSettledResult<B>>> => {
  const settled: Array<PromiseSettledResult<B>> = []
  for (let offset = 0; offset < values.length; offset += CONCURRENCY) {
    if (signal.aborted) break
    settled.push(
      ...(await Promise.allSettled(values.slice(offset, offset + CONCURRENCY).map(operation)))
    )
  }
  return settled
}

const WRITE_OUTCOME = { done: "done", failed: "failed", interrupted: "interrupted" } as const

type WriteOutcome =
  | { readonly kind: typeof WRITE_OUTCOME.done }
  | { readonly kind: typeof WRITE_OUTCOME.failed; readonly reason: string }
  | { readonly kind: typeof WRITE_OUTCOME.interrupted; readonly cause: unknown }

export const settleWrite = (settled: PromiseSettledResult<unknown> | undefined): WriteOutcome => {
  if (settled === undefined) return { kind: WRITE_OUTCOME.interrupted, cause: undefined }
  if (isFulfilled(settled)) return { kind: WRITE_OUTCOME.done }
  if (settled.reason instanceof ToolExecutionError) {
    return { kind: WRITE_OUTCOME.failed, reason: settled.reason.preview ?? settled.reason.message }
  }
  return { kind: WRITE_OUTCOME.interrupted, cause: settled.reason }
}

export const raiseIfNothingDone = (
  outcomes: ReadonlyArray<WriteOutcome>,
  signal: AbortSignal
): void => {
  if (outcomes.some((outcome) => outcome.kind === WRITE_OUTCOME.done)) return
  const stopped = outcomes.find((outcome) => outcome.kind === WRITE_OUTCOME.interrupted)
  if (stopped?.kind === WRITE_OUTCOME.interrupted && stopped.cause !== undefined)
    throw stopped.cause
  signal.throwIfAborted()
}

const interruptedReason = "not attempted: the call was interrupted"

export const isDone = (outcome: WriteOutcome | undefined): boolean =>
  outcome?.kind === WRITE_OUTCOME.done

export const failedReason = (outcome: WriteOutcome | undefined): string =>
  outcome?.kind === WRITE_OUTCOME.failed ? outcome.reason : interruptedReason
