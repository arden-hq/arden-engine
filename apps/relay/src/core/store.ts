import type { PresenceState } from "@arden-hq/relay-protocol"

// Persistent state for ONE Mac (a Durable Object's storage, or rows scoped by
// `mac` in the Bun relay's shared database). Synchronous on purpose: both
// `ctx.storage.sql` and `bun:sqlite` are synchronous, and the core then needs

export interface MacRecord {
  readonly mac: string
  readonly edPub: string
  readonly state: PresenceState
  readonly lastSeen: number
}

export interface DeviceRecord {
  readonly dev: string
  readonly edPub: string
  readonly name: string
  readonly addedAt: number
  readonly lastSeen: number
}

export interface LeftRecord {
  readonly dev: string
  readonly sig: string
  readonly at: number
}

export interface QueuedRow {
  readonly id: string
  readonly from: string
  readonly body: Uint8Array
  readonly storedAt: number
}

export interface Store {
  getMac(): MacRecord | undefined
  putMac(record: MacRecord): void
  setMacPresence(state: PresenceState, lastSeen: number): void

  getDevice(dev: string): DeviceRecord | undefined
  listDevices(): DeviceRecord[]
  putDevice(record: DeviceRecord): void
  deleteDevice(dev: string): void
  touchDevice(dev: string, lastSeen: number): void

  putLeft(record: LeftRecord): void
  listLeft(): LeftRecord[]
  deleteLeft(dev: string): void
  deleteLeftBefore(cutoff: number): void

  putPairOffer(offer: { tokenHash: string; expires: number }): void
  takePairOffer(tokenHash: string, now: number): boolean
  countPairOffers(): number
  deletePairOffersExpiredBy(now: number): void

  enqueue(row: QueuedRow): "stored" | "duplicate"
  queueUsage(): { rows: number; bytes: number }
  listQueued(): QueuedRow[]
  dequeue(id: string): void
  deleteQueuedFrom(dev: string): void
  deleteQueuedBefore(cutoff: number): void
}
