import { afterEach, describe, expect, it, setSystemTime } from "bun:test"
import { fromB64url, fromUtf8, utf8 } from "@arden-hq/relay-protocol"
import { buildApnsRequest, createApnsPusher, mapApnsResponse } from "../src/apns/apns.js"
import type { ApnsHttpResponse, ApnsTransport } from "../src/apns/apns.js"

type ApnsHttpRequest = Parameters<ApnsTransport>[0]
import type { PushRequest } from "../src/core/pusher.js"

const throwawayKey = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify"
  ])
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
  const base64 = btoa(String.fromCharCode(...der))
  const pem = `-----BEGIN PRIVATE KEY-----\n${base64.replace(/.{64}/g, "$&\n")}\n-----END PRIVATE KEY-----\n`
  return { pem, publicKey: pair.publicKey }
}

const request: PushRequest = {
  mac: "AbcdefghijklmnopqrstuV",
  dev: "BbcdefghijklmnopqrstuV",
  token: "ab".repeat(32),
  env: "sandbox",
  topic: "com.arden.ios",
  collapseId: "ask_1",
  priority: "high",
  body: utf8('{"aps":{}}')
}

const decodePart = (part: string | undefined): unknown =>
  JSON.parse(fromUtf8(fromB64url(part ?? "")))

const recordingTransport = (responses: ApnsHttpResponse[]) => {
  const sent: ApnsHttpRequest[] = []
  return {
    sent,
    transport: (http: ApnsHttpRequest) => {
      sent.push(http)
      const next = responses.shift()
      return next === undefined ? Promise.reject(new Error("offline")) : Promise.resolve(next)
    }
  }
}

describe("APNs pusher", () => {
  afterEach(() => setSystemTime())

  it("signs an ES256 provider token Apple's way, verifiable with the key's public half", async () => {
    setSystemTime(new Date(1_700_000_000_500))
    const key = await throwawayKey()
    const { sent, transport } = recordingTransport([{ status: 200, body: "" }])
    const pusher = createApnsPusher({
      credentials: { keyPem: key.pem, keyId: "KEYID12345", teamId: "TEAM123456" },
      transport
    })
    expect(await pusher.push(request)).toEqual({ status: "accepted" })
    const jwt = sent[0]?.headers["authorization"]?.replace("bearer ", "") ?? ""
    const [header, claims, signature] = jwt.split(".")
    expect([decodePart(header), decodePart(claims)]).toEqual([
      { alg: "ES256", kid: "KEYID12345" },
      { iss: "TEAM123456", iat: 1_700_000_000 }
    ])
    const signed = fromB64url(signature ?? "")
    expect(signed.length).toBe(64)
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key.publicKey,
        signed,
        utf8(`${header}.${claims}`)
      )
    ).toBe(true)
  })

  it("reuses the token for 50 minutes, then and after ExpiredProviderToken signs a new one", async () => {
    const key = await throwawayKey()
    setSystemTime(new Date(1_700_000_000_000))
    const { sent, transport } = recordingTransport([
      { status: 200, body: "" },
      { status: 200, body: "" },
      { status: 403, body: '{"reason":"ExpiredProviderToken"}' },
      { status: 200, body: "" }
    ])
    const pusher = createApnsPusher({
      credentials: { keyPem: key.pem, keyId: "K", teamId: "T" },
      transport
    })
    const iat = (index: number) => {
      const claims = sent[index]?.headers["authorization"]?.split(".")[1]
      const decoded = decodePart(claims)
      return typeof decoded === "object" && decoded !== null
        ? Reflect.get(decoded, "iat")
        : undefined
    }
    await pusher.push(request)
    setSystemTime(new Date(Date.now() + 49 * 60_000))
    await pusher.push(request)
    setSystemTime(new Date(Date.now() + 2 * 60_000))
    expect(await pusher.push(request)).toEqual({
      status: "rejected",
      reason: "ExpiredProviderToken"
    })
    await pusher.push(request)
    expect([iat(0), iat(1), iat(2), iat(3)]).toEqual([
      1_700_000_000, 1_700_000_000, 1_700_003_060, 1_700_003_060
    ])
    expect(sent[2]?.headers["authorization"]).not.toBe(sent[3]?.headers["authorization"])
  })

  it("answers unavailable on a network failure or a key that does not import", async () => {
    const key = await throwawayKey()
    const offline = createApnsPusher({
      credentials: { keyPem: key.pem, keyId: "K", teamId: "T" },
      transport: recordingTransport([]).transport
    })
    const broken = createApnsPusher({
      credentials: { keyPem: "not a key", keyId: "K", teamId: "T" },
      transport: recordingTransport([{ status: 200, body: "" }]).transport
    })
    expect([await offline.push(request), await broken.push(request)]).toEqual([
      { status: "unavailable", reason: "NetworkError" },
      { status: "unavailable", reason: "InvalidProviderKey" }
    ])
  })

  it("builds the request by environment and priority", () => {
    expect(buildApnsRequest(request, "jwt")).toEqual({
      url: `https://api.sandbox.push.apple.com/3/device/${request.token}`,
      headers: {
        authorization: "bearer jwt",
        "apns-topic": "com.arden.ios",
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-collapse-id": "ask_1",
        "apns-expiration": "0",
        "content-type": "application/json"
      },
      body: request.body
    })
    const production = buildApnsRequest({ ...request, env: "production", priority: "normal" }, "j")
    expect([production.url, production.headers["apns-priority"]]).toEqual([
      `https://api.push.apple.com/3/device/${request.token}`,
      "5"
    ])
  })

  it("maps Apple's answers: 200 accepted, 400/403/410 rejected with the reason, the rest unavailable", () => {
    expect(
      [
        { status: 200, body: "" },
        { status: 400, body: '{"reason":"BadDeviceToken"}' },
        { status: 403, body: '{"reason":"InvalidProviderToken"}' },
        { status: 410, body: '{"reason":"Unregistered","timestamp":1}' },
        { status: 429, body: '{"reason":"TooManyRequests"}' },
        { status: 503, body: "<html>" }
      ].map(mapApnsResponse)
    ).toEqual([
      { status: "accepted" },
      { status: "rejected", reason: "BadDeviceToken" },
      { status: "rejected", reason: "InvalidProviderToken" },
      { status: "rejected", reason: "Unregistered" },
      { status: "unavailable", reason: "TooManyRequests" },
      { status: "unavailable", reason: "HTTP 503" }
    ])
  })
})
