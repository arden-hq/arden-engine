import { toB64url, utf8 } from "@arden-hq/relay-protocol"
import type { Pusher, PushRequest, PushResult } from "../core/pusher.js"

// The APNs sender, free of any host: a provider token signed with WebCrypto
// (Bun and Workers both have it) and an injected HTTP/2 transport, since APNs
// refuses HTTP/1.1. Cloudflare's fetch speaks HTTP/2 to Apple; Bun's does not,
// so the Bun host passes a node:http2 transport.

interface ApnsHttpRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}
export interface ApnsHttpResponse {
  readonly status: number
  readonly body: string
}
export type ApnsTransport = (request: ApnsHttpRequest) => Promise<ApnsHttpResponse>

export interface ApnsCredentials {
  readonly keyPem: string
  readonly keyId: string
  readonly teamId: string
}

/** Apple accepts a token for 60 min and throttles refreshes under 20 min. */
const tokenLifetimeMs = 50 * 60_000

const hosts = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com"
} as const

export const createApnsPusher = ({
  credentials,
  transport
}: {
  credentials: ApnsCredentials
  transport: ApnsTransport
}): Pusher => {
  const key = importP8(credentials.keyPem)
  key.catch(() => {})
  // The promise is cached so concurrent pushes share one token (Apple throttles new ones).
  let cached: { readonly jwt: Promise<string | undefined>; readonly issued: number } | undefined
  const providerToken = (): Promise<string | undefined> => {
    const at = Date.now()
    if (cached !== undefined && at - cached.issued < tokenLifetimeMs) return cached.jwt
    const jwt = key
      .then((signingKey) =>
        signProviderToken({
          key: signingKey,
          keyId: credentials.keyId,
          teamId: credentials.teamId,
          issuedAt: at
        })
      )
      .catch(() => {
        cached = undefined
        return undefined
      })
    cached = { jwt, issued: at }
    return jwt
  }
  return {
    push: async (request) => {
      const jwt = await providerToken()
      if (jwt === undefined) return { status: "unavailable", reason: "InvalidProviderKey" }
      const response = await transport(buildApnsRequest(request, jwt)).catch(() => undefined)
      if (response === undefined) return { status: "unavailable", reason: "NetworkError" }
      const result = mapApnsResponse(response)
      if (result.status === "rejected" && result.reason === "ExpiredProviderToken")
        cached = undefined
      return result
    }
  }
}

const importP8 = (pem: string): Promise<CryptoKey> => {
  const base64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "")
  const der = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign"
  ])
}

const signProviderToken = async ({
  key,
  keyId,
  teamId,
  issuedAt
}: {
  key: CryptoKey
  keyId: string
  teamId: string
  issuedAt: number
}): Promise<string> => {
  const header = toB64url(utf8(JSON.stringify({ alg: "ES256", kid: keyId })))
  const claims = toB64url(utf8(JSON.stringify({ iss: teamId, iat: Math.floor(issuedAt / 1000) })))
  const input = `${header}.${claims}`
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(input))
  return `${input}.${toB64url(new Uint8Array(signature))}`
}

export const buildApnsRequest = (request: PushRequest, jwt: string): ApnsHttpRequest => ({
  url: `${hosts[request.env]}/3/device/${request.token}`,
  headers: {
    authorization: `bearer ${jwt}`,
    "apns-topic": request.topic,
    "apns-push-type": "alert",
    "apns-priority": request.priority === "high" ? "10" : "5",
    "apns-collapse-id": request.collapseId,
    "apns-expiration": "0",
    "content-type": "application/json"
  },
  body: request.body
})

/** 400/403/410 are Apple refusing this push (410 Unregistered: drop the token); the rest may pass on retry. */
export const mapApnsResponse = (response: ApnsHttpResponse): PushResult => {
  if (response.status === 200) return { status: "accepted" }
  const reason = appleReason(response.body) ?? `HTTP ${response.status}`
  switch (response.status) {
    case 400:
    case 403:
    case 410:
      return { status: "rejected", reason }
    default:
      return { status: "unavailable", reason }
  }
}

const appleReason = (body: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const reason: unknown = Reflect.get(parsed, "reason")
    return typeof reason === "string" && reason.length <= 64 ? reason : undefined
  } catch {
    return undefined
  }
}
