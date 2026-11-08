import { existsSync, readFileSync } from "node:fs"
import { connect } from "node:http2"
import type { ClientHttp2Session } from "node:http2"
import { createApnsPusher } from "../apns/apns.js"
import type { ApnsHttpResponse, ApnsTransport } from "../apns/apns.js"
import { noopPusher } from "../core/pusher.js"
import type { Pusher } from "../core/pusher.js"

// APNs for the Bun host. Bun's fetch speaks only HTTP/1.1, which Apple
// refuses, so requests go over node:http2 — with ALPN set by hand: Bun's
// http2 client does not offer "h2" by default and the handshake fails.

const requestTimeoutMs = 15_000

export interface Http2Transport {
  readonly transport: ApnsTransport
  close(): void
}

export const http2Transport = (): Http2Transport => {
  const sessions = new Map<string, ClientHttp2Session>()
  const sessionFor = (origin: string): ClientHttp2Session => {
    const open = sessions.get(origin)
    if (open !== undefined && !open.closed && !open.destroyed) return open
    const session = connect(origin, { ALPNProtocols: ["h2"] })
    const forget = () => {
      if (sessions.get(origin) === session) sessions.delete(origin)
    }
    session.on("error", forget)
    session.on("goaway", forget)
    session.on("close", forget)
    sessions.set(origin, session)
    return session
  }
  const transport: ApnsTransport = (request) =>
    new Promise<ApnsHttpResponse>((resolve, reject) => {
      const url = new URL(request.url)
      const stream = sessionFor(url.origin).request({
        ":method": "POST",
        ":path": url.pathname,
        ...request.headers
      })
      stream.setTimeout(requestTimeoutMs, () => stream.close())
      let status = 0
      const chunks: Buffer[] = []
      stream.on("response", (headers) => {
        status = Number(headers[":status"])
      })
      stream.on("data", (chunk: Buffer) => chunks.push(chunk))
      stream.on("error", reject)
      stream.on("close", () => {
        if (status === 0) reject(new Error("APNs stream closed without a response"))
        else resolve({ status, body: Buffer.concat(chunks).toString("utf8") })
      })
      stream.end(request.body)
    })
  return {
    transport,
    close: () => {
      for (const session of sessions.values()) session.close()
      sessions.clear()
    }
  }
}

export const pusherFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  transport: ApnsTransport
): { readonly pusher: Pusher; readonly configured: boolean } => {
  const path = env["ARDEN_APNS_KEY_PATH"]
  const keyId = env["ARDEN_APNS_KEY_ID"]
  const teamId = env["ARDEN_APNS_TEAM_ID"]
  if (!path || !keyId || !teamId || !existsSync(path))
    return { pusher: noopPusher, configured: false }
  const credentials = { keyPem: readFileSync(path, "utf8"), keyId, teamId }
  return { pusher: createApnsPusher({ credentials, transport }), configured: true }
}
