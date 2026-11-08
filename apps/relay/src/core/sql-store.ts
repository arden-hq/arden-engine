import type { PresenceState } from "@arden-hq/relay-protocol"
import type { DeviceRecord, LeftRecord, MacRecord, QueuedRow, Store } from "./store.js"

const schema = [
  `CREATE TABLE IF NOT EXISTS macs (
    mac TEXT PRIMARY KEY,
    ed_pub TEXT NOT NULL,
    state TEXT NOT NULL,
    last_seen INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS devices (
    mac TEXT NOT NULL,
    dev TEXT NOT NULL,
    ed_pub TEXT NOT NULL,
    name TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (mac, dev)
  )`,
  `CREATE TABLE IF NOT EXISTS left_devices (
    mac TEXT NOT NULL,
    dev TEXT NOT NULL,
    sig TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (mac, dev)
  )`,
  `CREATE TABLE IF NOT EXISTS pair_offers (
    mac TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires INTEGER NOT NULL,
    PRIMARY KEY (mac, token_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS queue (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    mac TEXT NOT NULL,
    id TEXT NOT NULL,
    from_dev TEXT NOT NULL,
    body BLOB NOT NULL,
    stored_at INTEGER NOT NULL,
    UNIQUE (mac, id)
  )`
] as const

type SqlValue = string | number | Uint8Array | null

export interface Sql {
  run(statement: string, params: readonly SqlValue[]): void
  all(statement: string, params: readonly SqlValue[]): Record<string, unknown>[]
}

export const migrate = (sql: Sql): void => {
  for (const statement of schema) sql.run(statement, [])
}

export class SqlStore implements Store {
  readonly #sql: Sql
  readonly #mac: string

  constructor(options: { sql: Sql; mac: string }) {
    this.#sql = options.sql
    this.#mac = options.mac
  }

  getMac(): MacRecord | undefined {
    const row = this.#sql.all("SELECT * FROM macs WHERE mac = ?", [this.#mac])[0]
    if (row === undefined) return undefined
    return {
      mac: this.#mac,
      edPub: text(row, "ed_pub"),
      state: presence(row["state"]),
      lastSeen: int(row, "last_seen")
    }
  }

  putMac(record: MacRecord): void {
    this.#sql.run(
      "INSERT OR REPLACE INTO macs (mac, ed_pub, state, last_seen) VALUES (?, ?, ?, ?)",
      [record.mac, record.edPub, record.state, record.lastSeen]
    )
  }

  setMacPresence(state: PresenceState, lastSeen: number): void {
    this.#sql.run("UPDATE macs SET state = ?, last_seen = ? WHERE mac = ?", [
      state,
      lastSeen,
      this.#mac
    ])
  }

  getDevice(dev: string): DeviceRecord | undefined {
    const row = this.#sql.all("SELECT * FROM devices WHERE mac = ? AND dev = ?", [
      this.#mac,
      dev
    ])[0]
    return row === undefined ? undefined : device(row)
  }

  listDevices(): DeviceRecord[] {
    return this.#sql
      .all("SELECT * FROM devices WHERE mac = ? ORDER BY added_at, dev", [this.#mac])
      .map(device)
  }

  putDevice(record: DeviceRecord): void {
    this.#sql.run(
      "INSERT OR REPLACE INTO devices (mac, dev, ed_pub, name, added_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)",
      [this.#mac, record.dev, record.edPub, record.name, record.addedAt, record.lastSeen]
    )
  }

  deleteDevice(dev: string): void {
    this.#sql.run("DELETE FROM devices WHERE mac = ? AND dev = ?", [this.#mac, dev])
  }

  touchDevice(dev: string, lastSeen: number): void {
    this.#sql.run("UPDATE devices SET last_seen = ? WHERE mac = ? AND dev = ?", [
      lastSeen,
      this.#mac,
      dev
    ])
  }

  putLeft(record: LeftRecord): void {
    this.#sql.run("INSERT OR REPLACE INTO left_devices (mac, dev, sig, at) VALUES (?, ?, ?, ?)", [
      this.#mac,
      record.dev,
      record.sig,
      record.at
    ])
  }

  listLeft(): LeftRecord[] {
    return this.#sql
      .all("SELECT * FROM left_devices WHERE mac = ? ORDER BY at, dev", [this.#mac])
      .map((row) => ({ dev: text(row, "dev"), sig: text(row, "sig"), at: int(row, "at") }))
  }

  deleteLeft(dev: string): void {
    this.#sql.run("DELETE FROM left_devices WHERE mac = ? AND dev = ?", [this.#mac, dev])
  }

  deleteLeftBefore(cutoff: number): void {
    this.#sql.run("DELETE FROM left_devices WHERE mac = ? AND at < ?", [this.#mac, cutoff])
  }

  putPairOffer(offer: { tokenHash: string; expires: number }): void {
    this.#sql.run(
      "INSERT OR REPLACE INTO pair_offers (mac, token_hash, expires) VALUES (?, ?, ?)",
      [this.#mac, offer.tokenHash, offer.expires]
    )
  }

  takePairOffer(tokenHash: string, now: number): boolean {
    const row = this.#sql.all("SELECT expires FROM pair_offers WHERE mac = ? AND token_hash = ?", [
      this.#mac,
      tokenHash
    ])[0]
    this.#sql.run("DELETE FROM pair_offers WHERE mac = ? AND token_hash = ?", [
      this.#mac,
      tokenHash
    ])
    return row !== undefined && int(row, "expires") > now
  }

  countPairOffers(): number {
    return int(
      this.#sql.all("SELECT COUNT(*) AS n FROM pair_offers WHERE mac = ?", [this.#mac])[0] ?? {},
      "n"
    )
  }

  deletePairOffersExpiredBy(now: number): void {
    this.#sql.run("DELETE FROM pair_offers WHERE mac = ? AND expires <= ?", [this.#mac, now])
  }

  enqueue(row: QueuedRow): "stored" | "duplicate" {
    const existing = this.#sql.all("SELECT 1 FROM queue WHERE mac = ? AND id = ?", [
      this.#mac,
      row.id
    ])
    if (existing.length > 0) return "duplicate"
    this.#sql.run("INSERT INTO queue (mac, id, from_dev, body, stored_at) VALUES (?, ?, ?, ?, ?)", [
      this.#mac,
      row.id,
      row.from,
      row.body,
      row.storedAt
    ])
    return "stored"
  }

  queueUsage(): { rows: number; bytes: number } {
    const row =
      this.#sql.all(
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS b FROM queue WHERE mac = ?",
        [this.#mac]
      )[0] ?? {}
    return { rows: int(row, "n"), bytes: int(row, "b") }
  }

  listQueued(): QueuedRow[] {
    return this.#sql
      .all("SELECT * FROM queue WHERE mac = ? ORDER BY seq", [this.#mac])
      .map((row) => ({
        id: text(row, "id"),
        from: text(row, "from_dev"),
        body: blob(row["body"]),
        storedAt: int(row, "stored_at")
      }))
  }

  dequeue(id: string): void {
    this.#sql.run("DELETE FROM queue WHERE mac = ? AND id = ?", [this.#mac, id])
  }

  deleteQueuedFrom(dev: string): void {
    this.#sql.run("DELETE FROM queue WHERE mac = ? AND from_dev = ?", [this.#mac, dev])
  }

  deleteQueuedBefore(cutoff: number): void {
    this.#sql.run("DELETE FROM queue WHERE mac = ? AND stored_at < ?", [this.#mac, cutoff])
  }
}

const device = (row: Record<string, unknown>): DeviceRecord => ({
  dev: text(row, "dev"),
  edPub: text(row, "ed_pub"),
  name: text(row, "name"),
  addedAt: int(row, "added_at"),
  lastSeen: int(row, "last_seen")
})

const text = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value !== "string") throw new Error(`relay store: ${column} is not text`)
  return value
}

const int = (row: Record<string, unknown>, column: string): number => {
  const value = row[column]
  if (typeof value === "bigint") return Number(value)
  if (typeof value !== "number") throw new Error(`relay store: ${column} is not an integer`)
  return value
}

const presence = (value: unknown): PresenceState => {
  switch (value) {
    case "online":
    case "asleep":
    case "offline":
      return value
    default:
      throw new Error(`relay store: unknown presence ${String(value)}`)
  }
}

/** bun:sqlite returns Uint8Array, the Durable Object SQL API an ArrayBuffer. */
const blob = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new Error("relay store: body is not a blob")
}
