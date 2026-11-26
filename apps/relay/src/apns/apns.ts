import { APNS_REASON, PUSH_STATUS, toB64url, utf8 } from "@arden-hq/relay-protocol"
import type { ApnsEnvironment, PushOutcome, PushPriority } from "@arden-hq/relay-protocol"
import type { Pusher, PushRequest } from "../core/pusher.js"
import { parseJsonText } from "@arden-hq/std/json-text"

interface ApnsHttpRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}
export interface ApnsHttpResponse {
  readonly status: number
  readonly body: string
}
// APNs takes HTTP/2 only: https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
export type ApnsTransport = (request: ApnsHttpRequest) => Promise<ApnsHttpResponse>

export interface ApnsCredentials {
  readonly keyPem: string
  readonly keyId: string
  readonly teamId: string
}

// Refresh between 20 and 60 minutes: https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
const tokenLifetimeMs = 50 * 60_000

const hosts: Readonly<Record<ApnsEnvironment, string>> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com"
}

const apnsPriority: Readonly<Record<PushPriority, string>> = { high: "10", normal: "5" }

export const createApnsPusher = ({
  credentials,
  transport
}: {
  credentials: ApnsCredentials
  transport: ApnsTransport
}): Pusher => {
  const key = importP8(credentials.keyPem)
  key.catch(() => {})
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
      if (jwt === undefined)
        return { status: PUSH_STATUS.unavailable, reason: "InvalidProviderKey" }
      const response = await transport(buildApnsRequest(request, jwt)).catch(() => undefined)
      if (response === undefined) return { status: PUSH_STATUS.unavailable, reason: "NetworkError" }
      const result = mapApnsResponse(response)
      if (
        result.status === PUSH_STATUS.rejected &&
        result.reason === APNS_REASON.ExpiredProviderToken
      )
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

const buildApnsRequest = (request: PushRequest, jwt: string): ApnsHttpRequest => ({
  url: `${hosts[request.env]}/3/device/${request.token}`,
  headers: {
    authorization: `bearer ${jwt}`,
    "apns-topic": request.topic,
    "apns-push-type": "alert",
    "apns-priority": apnsPriority[request.priority],
    "apns-collapse-id": request.collapseId,
    "apns-expiration": "0",
    "content-type": "application/json"
  },
  body: request.body
})

// https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns
const mapApnsResponse = (response: ApnsHttpResponse): PushOutcome => {
  if (response.status === 200) return { status: PUSH_STATUS.accepted }
  const reason = appleReason(response.body) ?? `HTTP ${response.status}`
  switch (response.status) {
    case 400:
    case 403:
    case 410:
      return { status: PUSH_STATUS.rejected, reason }
    default:
      return { status: PUSH_STATUS.unavailable, reason }
  }
}

const appleReason = (body: string): string | undefined => {
  try {
    const parsed: unknown = parseJsonText(body)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const reason: unknown = Reflect.get(parsed, "reason")
    return typeof reason === "string" && reason.length <= 64 ? reason : undefined
  } catch {
    return undefined
  }
}
