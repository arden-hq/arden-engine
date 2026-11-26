import type { Queue } from "effect"

import type { JournalRecord } from "../types.js"

export const SIGNAL_KIND = { wake: "wake", transient: "transient" } as const

export interface WakeSignal {
  readonly kind: typeof SIGNAL_KIND.wake
  throughSequence: number
}

export interface TransientSignal {
  readonly kind: typeof SIGNAL_KIND.transient
  readonly records: Array<JournalRecord>
  bytes: number
}

export type SubscriberSignal = WakeSignal | TransientSignal

export interface Subscriber {
  readonly queue: Queue.Queue<SubscriberSignal>
  pendingTail: SubscriberSignal | undefined
  overflowed: boolean
  queuedRecords: number
  queuedBytes: number
}

export const coalescableTail = <K extends SubscriberSignal["kind"]>(
  subscriber: Subscriber,
  kind: K
): Extract<SubscriberSignal, { readonly kind: K }> | undefined =>
  subscriber.pendingTail?.kind === kind
    ? (subscriber.pendingTail as Extract<SubscriberSignal, { readonly kind: K }>)
    : undefined

export type Subscribers = Map<string, Set<Subscriber>>
