import { setSystemTime } from "bun:test"
import { decodeFrame, encodeFrame, parseRelayHeader } from "@arden-hq/relay-protocol"
import type { ClientHeader, RelayHeader } from "@arden-hq/relay-protocol"
import { startRelay } from "../src/bun/server.js"
import { noopPusher } from "../src/core/pusher.js"
import type { Pusher } from "../src/core/pusher.js"

interface HarnessOptions {
  readonly pusher?: Pusher
}

interface Received {
  readonly header: RelayHeader
  readonly body: Uint8Array
}

export interface Client {
  send(header: ClientHeader, body?: Uint8Array): void
  sendText(text: string): void
  next<T extends RelayHeader["t"]>(
    t: T
  ): Promise<{ header: Extract<RelayHeader, { t: T }>; body: Uint8Array }>
  nextText(): Promise<string>
  pending(): string[]
  readonly closed: Promise<number>
  close(): void
}

export interface Harness {
  connect(mac: string): Promise<Client>
  now(): number
  advance(ms: number): void
  tick(): void
  stop(): Promise<void>
}

const timeoutMs = 2_000

const inbox = () => {
  const frames: Received[] = []
  const texts: string[] = []
  let wake: (() => void) | undefined
  let resolveClosed: (code: number) => void = () => {}
  const closed = new Promise<number>((resolve) => {
    resolveClosed = resolve
  })
  const poke = () => {
    wake?.()
    wake = undefined
  }
  const waitFor = async <R>(take: () => R | undefined, what: string): Promise<R> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = take()
      if (found !== undefined) return found
      if (Date.now() > deadline)
        throw new Error(
          `timed out waiting for ${what}; buffered: ${frames.map((f) => f.header.t).join(",")}`
        )
      await new Promise<void>((resolve) => {
        wake = resolve
        setTimeout(resolve, 20)
      })
    }
  }
  return {
    closed,
    pushFrame: (data: Uint8Array) => {
      const decoded = decodeFrame(data)
      const header = decoded.ok ? parseRelayHeader(decoded.header) : undefined
      if (!decoded.ok || header === undefined) throw new Error("relay sent an unreadable frame")
      frames.push({ header, body: decoded.body })
      poke()
    },
    pushText: (text: string) => {
      texts.push(text)
      poke()
    },
    markClosed: (code: number) => {
      resolveClosed(code)
      poke()
    },
    next: <T extends RelayHeader["t"]>(t: T) =>
      waitFor(() => {
        const index = frames.findIndex((frame) => frame.header.t === t)
        if (index < 0) return undefined
        const [frame] = frames.splice(index, 1)
        if (frame === undefined || !isType(frame.header, t)) return undefined
        return { header: frame.header, body: frame.body }
      }, t),
    nextText: () => waitFor(() => texts.shift(), "text"),
    pending: () => frames.map((frame) => frame.header.t)
  }
}

const isType = <T extends RelayHeader["t"]>(
  header: RelayHeader,
  t: T
): header is Extract<RelayHeader, { t: T }> => header.t === t

export const bunHarness = ({ pusher = noopPusher }: HarnessOptions = {}): Harness => {
  setSystemTime(new Date(1_700_000_000_000))
  const relay = startRelay({ port: 0, pusher })
  const open = new Set<WebSocket>()
  return {
    connect: async (mac) => {
      const socket = new WebSocket(`${relay.url}/v1/connect?mac=${mac}`)
      open.add(socket)
      socket.binaryType = "arraybuffer"
      const box = inbox()
      socket.addEventListener("message", (event: MessageEvent) => {
        const data: unknown = event.data
        if (typeof data === "string") box.pushText(data)
        else if (data instanceof ArrayBuffer) box.pushFrame(new Uint8Array(data))
      })
      socket.addEventListener("close", (event: CloseEvent) => box.markClosed(event.code))
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve())
        socket.addEventListener("error", () => reject(new Error("connect failed")))
      })
      return {
        send: (header, body) => socket.send(encodeFrame(header, body)),
        sendText: (text) => socket.send(text),
        next: box.next,
        nextText: box.nextText,
        pending: box.pending,
        closed: box.closed,
        close: () => socket.close(1000)
      }
    },
    now: () => Date.now(),
    advance: (ms) => {
      setSystemTime(new Date(Date.now() + ms))
    },
    tick: () => relay.tick(),
    stop: async () => {
      for (const socket of open) socket.close(1000)
      await relay.stop()
      setSystemTime()
    }
  }
}
