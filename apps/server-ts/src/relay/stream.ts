import { ladderDelayMs } from "@arden-hq/std/retry"
import { sleep } from "@arden-hq/std/sleep"
import type { EventMessage, ResetMessage } from "@arden-hq/relay-protocol"
import type { Schema } from "effect"
import type { Loopback, RelayLog } from "./ports.js"
import type { StreamRoute } from "./routes.js"
import { errorMessage } from "@arden-hq/std/errors"

const StreamLimits = {
  ring: 2_000,
  windowEvents: 256,
  windowBytes: 1024 * 1024,
  retryMs: [500, 1_000, 2_000, 5_000, 10_000]
} as const

interface Entry {
  readonly seq: number
  readonly data: Schema.Json
  readonly bytes: number
}

type Sink = (message: EventMessage | ResetMessage) => void

const parse = (data: string): Schema.Json => {
  try {
    const value: Schema.Json = JSON.parse(data)
    return value
  } catch {
    return data
  }
}

export class RelayStream {
  readonly sid: string
  readonly route: StreamRoute
  readonly #loopback: Loopback
  readonly #log: RelayLog
  #ring: Entry[] = []
  #nextSeq = 1
  #sent = 0
  #acked = 0
  #lastEventId: string | undefined
  #upstream = new AbortController()
  #sink: Sink | undefined

  constructor(options: {
    readonly sid: string
    readonly route: StreamRoute
    readonly loopback: Loopback
    readonly log: RelayLog
  }) {
    this.sid = options.sid
    this.route = options.route
    this.#loopback = options.loopback
    this.#log = options.log
    void this.#run(this.#upstream.signal)
  }

  attach(sink: Sink, fromSeq: number | undefined): void {
    this.#sink = sink
    const last = this.#nextSeq - 1
    const oldest = this.#ring[0]?.seq ?? this.#nextSeq
    if (fromSeq === undefined) {
      if (last > 0) this.#restart()
      return
    }
    if (fromSeq > last || fromSeq + 1 < oldest) {
      sink({ t: "reset", sid: this.sid, reason: "gap" })
      this.#restart()
      return
    }
    this.#sent = fromSeq
    this.#acked = fromSeq
    this.#pump()
  }

  detach(): void {
    this.#sink = undefined
  }

  ack(seq: number): void {
    this.#acked = Math.max(this.#acked, Math.min(seq, this.#sent))
    this.#pump()
  }

  close(): void {
    this.#sink = undefined
    this.#upstream.abort()
  }

  #push(data: Schema.Json): void {
    const bytes = JSON.stringify(data).length
    this.#ring.push({ seq: this.#nextSeq, data, bytes })
    this.#nextSeq += 1
    if (this.#ring.length > StreamLimits.ring) this.#ring.shift()
    this.#pump()
  }

  #pump(): void {
    const sink = this.#sink
    if (sink === undefined) return
    while (this.#sent < this.#nextSeq - 1) {
      if (this.#sent - this.#acked >= StreamLimits.windowEvents) return
      if (this.#unackedBytes() >= StreamLimits.windowBytes) return
      const entry = this.#entry(this.#sent + 1)
      if (entry === undefined) {
        sink({ t: "reset", sid: this.sid, reason: "overflow" })
        this.#restart()
        return
      }
      sink({ t: "ev", sid: this.sid, seq: entry.seq, data: entry.data })
      this.#sent = entry.seq
    }
  }

  #entry(seq: number): Entry | undefined {
    const first = this.#ring[0]
    return first === undefined ? undefined : this.#ring[seq - first.seq]
  }

  #unackedBytes(): number {
    let bytes = 0
    for (let seq = this.#acked + 1; seq <= this.#sent; seq++) bytes += this.#entry(seq)?.bytes ?? 0
    return bytes
  }

  #restart(): void {
    this.#upstream.abort()
    this.#upstream = new AbortController()
    this.#ring = []
    this.#nextSeq = 1
    this.#sent = 0
    this.#acked = 0
    this.#lastEventId = undefined
    void this.#run(this.#upstream.signal)
  }

  async #run(signal: AbortSignal): Promise<void> {
    let attempt = 0
    while (!signal.aborted) {
      try {
        const frames = this.#loopback.events({
          path: this.route.path,
          lastEventId: this.route.kind === "bus" ? this.#lastEventId : undefined,
          signal
        })
        for await (const frame of frames) {
          if (signal.aborted) return
          attempt = 0
          if (frame.id !== undefined) this.#lastEventId = frame.id
          this.#push(parse(frame.data))
        }
      } catch (cause) {
        if (signal.aborted) return
        this.#log("warning", "Relay stream lost its server connection", {
          route: this.route.kind,
          cause: errorMessage(cause)
        })
      }
      attempt += 1
      try {
        await sleep(ladderDelayMs(StreamLimits.retryMs, attempt), signal)
      } catch {
        return
      }
    }
  }
}
