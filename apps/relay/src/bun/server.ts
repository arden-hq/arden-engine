import { Database } from "bun:sqlite"
import type { SQLQueryBindings } from "bun:sqlite"
import type { ServerWebSocket } from "bun"
import { isDeviceId, MAX_FRAME_BYTES } from "@arden-hq/relay-protocol"
import type { Pusher } from "../core/pusher.js"
import { RelayCore } from "../core/relay-core.js"
import type { Attachment, Conns } from "../core/relay-core.js"
import { migrate, SqlStore } from "../core/sql-store.js"
import type { Sql } from "../core/sql-store.js"

interface SocketData {
  readonly mac: string
  attachment: Attachment | undefined
  lastPing: number | undefined
}

type Socket = ServerWebSocket<SocketData>

export interface RelayServer {
  readonly url: string
  readonly port: number
  tick(): void
  stop(): Promise<void>
}

export interface RelayServerOptions {
  readonly port?: number
  readonly hostname?: string
  readonly dbPath?: string
  readonly pusher?: Pusher
}

const ALARM_INTERVAL_MS = 5_000

export const startRelay = ({
  port = 8787,
  hostname = "127.0.0.1",
  dbPath = ":memory:",
  pusher
}: RelayServerOptions = {}): RelayServer => {
  const db = new Database(dbPath, { create: true, strict: true })
  db.run("PRAGMA journal_mode = WAL")
  const sql: Sql = {
    run: (statement, params) => {
      db.query<unknown, SQLQueryBindings[]>(statement).run(...params)
    },
    all: (statement, params) =>
      db.query<Record<string, unknown>, SQLQueryBindings[]>(statement).all(...params)
  }
  migrate(sql)

  let stopped = false
  const sockets = new Map<string, Set<Socket>>()
  const cores = new Map<string, RelayCore<Socket>>()

  const coreFor = (mac: string): RelayCore<Socket> => {
    const existing = cores.get(mac)
    if (existing !== undefined) return existing
    const open = sockets.get(mac) ?? new Set<Socket>()
    sockets.set(mac, open)
    const conns: Conns<Socket> = {
      send: (socket, frame) => {
        socket.send(frame)
      },
      close: (socket, code, reason) => socket.close(code, reason),
      sockets: () => [...open],
      attachment: (socket) => socket.data.attachment,
      setAttachment: (socket, attachment) => {
        socket.data.attachment = attachment
      },
      lastPing: (socket) => socket.data.lastPing
    }
    const core = new RelayCore<Socket>({
      mac,
      conns,
      store: new SqlStore({ sql, mac }),
      ...(pusher === undefined ? {} : { pusher })
    })
    cores.set(mac, core)
    return core
  }

  const tick = () => {
    for (const [mac, core] of cores) {
      core.onAlarm()
      if ((sockets.get(mac)?.size ?? 0) === 0) {
        cores.delete(mac)
        sockets.delete(mac)
      }
    }
  }

  const socketDataType: SocketData = { mac: "", attachment: undefined, lastPing: undefined }
  const server = Bun.serve({
    port,
    hostname,
    fetch: (request, bunServer) => {
      const url = new URL(request.url)
      if (url.pathname === "/v1/health") return new Response("ok")
      if (url.pathname !== "/v1/connect") return new Response("not found", { status: 404 })
      const mac = url.searchParams.get("mac")
      if (!isDeviceId(mac)) return new Response("bad mac id", { status: 400 })
      const data: SocketData = { mac, attachment: undefined, lastPing: undefined }
      return bunServer.upgrade(request, { data })
        ? undefined
        : new Response("expected a WebSocket", { status: 426 })
    },
    websocket: {
      // Type witness for ws.data (Bun's pattern); the real value comes from upgrade().
      data: socketDataType,
      maxPayloadLength: MAX_FRAME_BYTES,
      idleTimeout: 120,
      sendPings: false,
      open: (socket) => {
        const core = coreFor(socket.data.mac)
        sockets.get(socket.data.mac)?.add(socket)
        core.onOpen(socket)
      },
      message: (socket, message) => {
        if (typeof message === "string") {
          if (message !== "ping") return
          socket.data.lastPing = Date.now()
          socket.send("pong")
          return
        }
        coreFor(socket.data.mac).onFrame(
          socket,
          new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
        )
      },
      close: (socket) => {
        if (!stopped) coreFor(socket.data.mac).onClose(socket)
        sockets.get(socket.data.mac)?.delete(socket)
      }
    }
  })

  const interval = setInterval(tick, ALARM_INTERVAL_MS)
  const boundPort = server.port ?? port
  return {
    url: `ws://${hostname}:${boundPort}`,
    port: boundPort,
    tick,
    stop: () => {
      stopped = true
      clearInterval(interval)
      // Bun 1.3.10: stop(true) closes every socket and the listener at once,
      // but its promise never settles once the server has closed a socket
      // itself (auth failure, revoke), so it is not awaited.
      void server.stop(true)
      db.close()
      return Promise.resolve()
    }
  }
}
