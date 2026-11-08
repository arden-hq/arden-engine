import { Buffer } from "node:buffer"
import type { ChatProjectionEvent } from "@arden-hq/protocol"

const WINDOW_MS = 30_000
const BUCKET_MS = 1_000
const BUCKET_COUNT = WINDOW_MS / BUCKET_MS
const SNAPSHOT_INTERVAL_MS = 5_000
const BURST_EVENTS = 2_000
const BURST_BYTES = 1024 * 1024

export const deltaEventBytes = (event: ChatProjectionEvent): number | undefined =>
  event.type === "TEXT_MESSAGE_CONTENT" ||
  event.type === "REASONING_MESSAGE_CONTENT" ||
  event.type === "TOOL_CALL_ARGS" ||
  event.type === "TOOL_CALL_OUTPUT_DELTA"
    ? Buffer.byteLength(event.delta, "utf8")
    : undefined

interface DeltaObservation {
  readonly events: number
  readonly bytes: number
  readonly at: number
}

interface DeltaBurstSnapshot {
  readonly events: number
  readonly bytes: number
  readonly windowMs: number
}

export interface DeltaWindow {
  readonly observe: (input: DeltaObservation) => DeltaBurstSnapshot | undefined
}

interface DeltaBucket {
  readonly stamp: number
  readonly events: number
  readonly bytes: number
}

export const makeDeltaWindow = (): DeltaWindow => {
  let buckets: ReadonlyArray<DeltaBucket> = []
  let lastSnapshotAt: number | undefined

  const observe = (input: DeltaObservation): DeltaBurstSnapshot | undefined => {
    const stamp = Math.floor(input.at / BUCKET_MS)
    const retained = buckets.filter((bucket) => bucket.stamp > stamp - BUCKET_COUNT)
    const head = retained.at(-1)
    buckets =
      head?.stamp === stamp
        ? [
            ...retained.slice(0, -1),
            { stamp, events: head.events + input.events, bytes: head.bytes + input.bytes }
          ]
        : [...retained, { stamp, events: input.events, bytes: input.bytes }]

    const events = buckets.reduce((total, bucket) => total + bucket.events, 0)
    const bytes = buckets.reduce((total, bucket) => total + bucket.bytes, 0)
    if (events < BURST_EVENTS && bytes < BURST_BYTES) return undefined
    if (lastSnapshotAt !== undefined && input.at - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) {
      return undefined
    }
    lastSnapshotAt = input.at
    return { events, bytes, windowMs: WINDOW_MS }
  }

  return { observe }
}
