import { isDeviceId } from "@arden-hq/relay-protocol"
import { createApnsPusher } from "../apns/apns.js"
import type { ApnsTransport } from "../apns/apns.js"
import { noopPusher } from "../core/pusher.js"
import type { Pusher } from "../core/pusher.js"
import { RelayCore } from "../core/relay-core.js"
import type { Attachment, Conns } from "../core/relay-core.js"
import { migrate, SqlStore } from "../core/sql-store.js"
import type { Sql } from "../core/sql-store.js"
import type { CfWebSocket, DurableObjectNamespace, DurableObjectState } from "./workers-types.js"

// Cloudflare host: the Worker routes /v1/connect?mac= to one Durable Object
// per Mac (idFromName), which runs the RelayCore over the WebSocket
// Hibernation API. Text "ping" is a runtime auto-response, so heartbeats never
// wake the object; the core reads their time through lastPing.

export interface Env {
  readonly RELAY: DurableObjectNamespace
  readonly APNS_KEY?: string
  readonly APNS_KEY_ID?: string
  readonly APNS_TEAM_ID?: string
}

/** Workers' fetch negotiates HTTP/2 with Apple, which APNs requires. */
const fetchTransport: ApnsTransport = async (request) => {
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body
  })
  return { status: response.status, body: await response.text() }
}

const pusherFor = (env: Env): Pusher =>
  env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID
    ? createApnsPusher({
        credentials: { keyPem: env.APNS_KEY, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID },
        transport: fetchTransport
      })
    : noopPusher

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const url = new URL(request.url)
    if (url.pathname === "/v1/health") return new Response("ok")
    if (url.pathname !== "/v1/connect") return new Response("not found", { status: 404 })
    const mac = url.searchParams.get("mac")
    if (!isDeviceId(mac)) return new Response("bad mac id", { status: 400 })
    if (request.headers.get("Upgrade") !== "websocket")
      return new Response("expected a WebSocket", { status: 426 })
    return env.RELAY.get(env.RELAY.idFromName(mac)).fetch(request)
  }
}

interface Saved {
  readonly mac: string
  readonly attachment: Attachment
}

export class RelayObject {
  readonly #ctx: DurableObjectState
  readonly #sql: Sql
  readonly #pusher: Pusher
  #core: RelayCore<CfWebSocket> | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx
    this.#pusher = pusherFor(env)
    this.#sql = {
      run: (statement, params) => {
        ctx.storage.sql.exec(statement, ...params)
      },
      all: (statement, params) => ctx.storage.sql.exec(statement, ...params).toArray()
    }
    migrate(this.#sql)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))
  }

  fetch(request: Request): Response {
    const mac = new URL(request.url).searchParams.get("mac")
    if (!isDeviceId(mac)) return new Response("bad mac id", { status: 400 })
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.#ctx.acceptWebSocket(server)
    server.serializeAttachment({ mac, attachment: { state: "closed" } } satisfies Saved)
    this.#coreFor(mac).onOpen(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(socket: CfWebSocket, message: string | ArrayBuffer): void {
    if (typeof message === "string") return
    const core = this.#coreForSocket(socket)
    core?.onFrame(socket, new Uint8Array(message))
  }

  webSocketClose(socket: CfWebSocket): void {
    this.#coreForSocket(socket)?.onClose(socket)
  }

  webSocketError(socket: CfWebSocket): void {
    this.#coreForSocket(socket)?.onClose(socket)
  }

  alarm(): void {
    const fromSocket = this.#ctx
      .getWebSockets()
      .map(readSaved)
      .find((saved) => saved !== undefined)?.mac
    const mac = fromSocket ?? this.#sql.all("SELECT mac FROM macs LIMIT 1", [])[0]?.["mac"]
    if (typeof mac === "string") this.#coreFor(mac).onAlarm()
  }

  #coreForSocket(socket: CfWebSocket): RelayCore<CfWebSocket> | undefined {
    const saved = readSaved(socket)
    return saved === undefined ? undefined : this.#coreFor(saved.mac)
  }

  #coreFor(mac: string): RelayCore<CfWebSocket> {
    if (this.#core !== undefined) return this.#core
    const ctx = this.#ctx
    const conns: Conns<CfWebSocket> = {
      send: (socket, frame) => {
        try {
          socket.send(frame)
        } catch {}
      },
      close: (socket, code, reason) => {
        try {
          socket.close(code, reason)
        } catch {}
      },
      sockets: () => ctx.getWebSockets(),
      attachment: (socket) => readSaved(socket)?.attachment,
      setAttachment: (socket, attachment) => {
        socket.serializeAttachment({ mac, attachment } satisfies Saved)
      },
      lastPing: (socket) => ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime()
    }
    this.#core = new RelayCore<CfWebSocket>({
      mac,
      conns,
      store: new SqlStore({ sql: this.#sql, mac }),
      pusher: this.#pusher,
      scheduleAlarm: (at) => {
        void ctx.storage.getAlarm().then((current) => {
          if (current === null || current > at) return ctx.storage.setAlarm(at)
          return undefined
        })
      }
    })
    return this.#core
  }
}

const readSaved = (socket: CfWebSocket): Saved | undefined => {
  const value = socket.deserializeAttachment()
  if (typeof value !== "object" || value === null) return undefined
  const mac: unknown = Reflect.get(value, "mac")
  const attachment = toAttachment(Reflect.get(value, "attachment"))
  return typeof mac === "string" && attachment !== undefined ? { mac, attachment } : undefined
}

const toAttachment = (value: unknown): Attachment | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const field = (name: string): unknown => Reflect.get(value, name)
  const state = field("state")
  const dev = field("dev")
  const role = field("role")
  const nonce = field("nonce")
  const opened = field("opened")
  const heard = field("heard")
  switch (state) {
    case "closed":
      return { state }
    case "challenged":
      return typeof nonce === "string" && typeof opened === "number"
        ? { state, nonce, opened }
        : undefined
    case "pairing":
      return typeof dev === "string" && typeof opened === "number"
        ? { state, dev, opened }
        : undefined
    case "authed":
      return typeof dev === "string" &&
        typeof heard === "number" &&
        (role === "mac" || role === "phone")
        ? { state, role, dev, heard }
        : undefined
    default:
      return undefined
  }
}
