import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  decodeFrame,
  decodeMacMessage,
  decodePhoneMessage,
  encodeAppMessage,
  encodeFrame,
  MAX_FRAME_BYTES,
  PART_BYTES,
  PART_THRESHOLD,
  PartAssembler,
  parseClientHeader,
  parseRelayHeader,
  utf8,
  uuidv7
} from "@arden-hq/relay-protocol"

const dev = "AbcdefghijklmnopqrstuV"
const key = "A".repeat(43)
const sig = "B".repeat(86)

describe("relay frame codec", () => {
  it("decodes what it encodes: any header with a string t, any body", () => {
    const header = fc
      .tuple(fc.string(), fc.dictionary(fc.string(), fc.jsonValue({ maxDepth: 2 })))
      .map(([t, extra]) => ({ ...extra, t }))
    fc.assert(
      fc.property(header, fc.uint8Array({ maxLength: 64 }), (header, body) => {
        expect(decodeFrame(encodeFrame(header, body))).toEqual({
          ok: true,
          header: JSON.parse(JSON.stringify(header)),
          headerBytes: utf8(JSON.stringify(header)),
          body
        })
      })
    )
  })

  it("answers any bytes from the network with a frame or a reason, never a throw", () => {
    const headerText = fc.oneof(fc.json({ maxDepth: 2 }), fc.string())
    const frame = fc
      .tuple(
        fc.constantFrom(0, 1, 2),
        headerText.map(utf8),
        fc.option(fc.nat({ max: 0xffff })),
        fc.uint8Array({ maxLength: 8 }),
        fc.uint8Array({ maxLength: 4 })
      )
      .map(([version, header, declared, noise, body]) => {
        const length = declared ?? header.length
        return new Uint8Array([version, length >> 8, length & 0xff, ...noise, ...header, ...body])
      })
    fc.assert(
      fc.property(fc.oneof(frame, fc.uint8Array({ maxLength: 32 })), (bytes) => {
        const decoded = decodeFrame(bytes)
        if (decoded.ok) expect(typeof decoded.header.t).toBe("string")
        else
          expect(["too_large", "bad_version", "truncated", "bad_header"]).toContain(decoded.reason)
      })
    )
  })

  it("rejects bad version, truncation, oversize and non-object headers", () => {
    const good = encodeFrame({ t: "qack" })
    const badVersion = good.slice()
    badVersion[0] = 2
    expect([
      decodeFrame(badVersion),
      decodeFrame(good.slice(0, 4)),
      decodeFrame(new Uint8Array(MAX_FRAME_BYTES + 1)),
      decodeFrame(new Uint8Array([1, 0, 2, 0x5b, 0x5d])),
      decodeFrame(new Uint8Array([1, 0, 2, 0x7b, 0x7d]))
    ]).toEqual([
      { ok: false, reason: "bad_version" },
      { ok: false, reason: "truncated" },
      { ok: false, reason: "too_large" },
      { ok: false, reason: "bad_header" },
      { ok: false, reason: "bad_header" }
    ])
  })

  it("refuses to encode a frame over the limit", () => {
    expect(() => encodeFrame({ t: "msg" }, new Uint8Array(MAX_FRAME_BYTES))).toThrow()
  })
})

describe("header parsing", () => {
  it("accepts well-formed client headers and drops unknown fields", () => {
    expect(parseClientHeader({ t: "msg", to: dev, id: "abc", extra: 1 })).toEqual({
      t: "msg",
      to: dev,
      id: "abc"
    })
    expect(
      parseClientHeader({
        t: "auth",
        mac: dev,
        dev,
        role: "phone",
        sig,
        ed_pub: key,
        x_pub: key,
        name: "iPhone",
        pair_token: key
      })
    ).toEqual({
      t: "auth",
      mac: dev,
      dev,
      role: "phone",
      sig,
      ed_pub: key,
      x_pub: key,
      name: "iPhone",
      pair_token: key
    })
    expect(parseClientHeader({ t: "pair_deny", dev })).toEqual({ t: "pair_deny", dev })
  })

  it("rejects malformed client headers", () => {
    expect([
      parseClientHeader({ t: "msg", to: "short", id: "abc" }),
      parseClientHeader({ t: "msg", to: dev, id: "has space" }),
      parseClientHeader({ t: "auth", mac: dev, dev, role: "tablet", sig }),
      parseClientHeader({ t: "auth", mac: dev, dev, role: "mac", sig, ed_pub: "x" }),
      parseClientHeader({ t: "presence", state: "offline" }),
      parseClientHeader({ t: "pair_deny", dev: "short" }),
      parseClientHeader({ t: "nope" })
    ]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined])
  })

  it("parses relay headers with peers", () => {
    const peer = { dev, role: "mac", name: "Mac", online: false, state: "asleep", last_seen: 5 }
    expect(parseRelayHeader({ t: "ready", peers: [peer] })).toEqual({ t: "ready", peers: [peer] })
    expect(parseRelayHeader({ t: "ready", peers: [{ ...peer, online: "no" }] })).toBeUndefined()
  })

  it("parses push headers with an optional category and rejects bad tokens, envs and topics", () => {
    const push = {
      t: "push",
      id: "p1",
      dev,
      token: "ab".repeat(32),
      env: "sandbox",
      topic: "com.arden.ios",
      collapse_id: "ask_1",
      priority: "high"
    }
    expect(parseClientHeader(push)).toEqual(push)
    expect(parseClientHeader({ ...push, category: "arden.approval" })).toEqual({
      ...push,
      category: "arden.approval"
    })
    expect([
      parseClientHeader({ ...push, token: "zz".repeat(32) }),
      parseClientHeader({ ...push, token: "ab" }),
      parseClientHeader({ ...push, env: "staging" }),
      parseClientHeader({ ...push, topic: "com/arden" }),
      parseClientHeader({ ...push, category: "" }),
      parseClientHeader({ ...push, id: undefined })
    ]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined])
  })

  it("parses pushed replies: a reason only when not accepted", () => {
    expect(parseRelayHeader({ t: "pushed", id: "p1", status: "accepted" })).toEqual({
      t: "pushed",
      id: "p1",
      status: "accepted"
    })
    expect(
      parseRelayHeader({ t: "pushed", id: "p1", status: "rejected", reason: "Unregistered" })
    ).toEqual({ t: "pushed", id: "p1", status: "rejected", reason: "Unregistered" })
    expect(parseRelayHeader({ t: "pushed", id: "p1", status: "unavailable" })).toBeUndefined()
  })
})

describe("app messages", () => {
  it("delivers any message whole: one plaintext when it fits, else parts that reassemble", () => {
    const char = fc.constantFrom("a", "é", "€", "😀", '"', "\\", "\u0000")
    const body = fc
      .tuple(
        char,
        fc.integer({ min: 0, max: 3 * PART_BYTES }),
        fc.string({ unit: char, maxLength: 8 })
      )
      .map(([unit, bytes, tail]) => unit.repeat(Math.ceil(bytes / utf8(unit).length)) + tail)
    fc.assert(
      fc.property(body, fc.nat(), (body, status) => {
        const message = { t: "res", rid: "r", status, body } as const
        const parts = encodeAppMessage(message, { newId: () => "m1" })
        const json = utf8(JSON.stringify(message))
        if (json.length <= PART_THRESHOLD) expect(parts).toEqual([json])
        const assembler = new PartAssembler()
        const results = parts.map((part) => assembler.receive(part))
        expect(results.slice(0, -1).every((result) => result === undefined)).toBe(true)
        expect(decodeMacMessage(results.at(-1))).toEqual(message)
      }),
      { numRuns: 20 }
    )
  })

  it("throws on a part out of order", () => {
    const large = { t: "res", rid: "r", status: 200, body: "x".repeat(PART_THRESHOLD * 2) } as const
    const parts = encodeAppMessage(large, { newId: () => "m1" })
    const assembler = new PartAssembler()
    const [first, , third] = parts
    if (first === undefined || third === undefined) throw new Error("expected three parts")
    assembler.receive(first)
    expect(() => assembler.receive(third)).toThrow()
  })

  it("decodes phone messages and rejects bad ones", () => {
    expect(decodePhoneMessage({ t: "cmd", cid: "c", ts: 1, kind: "stop", args: {} })).toEqual({
      t: "cmd",
      cid: "c",
      ts: 1,
      kind: "stop",
      args: {}
    })
    expect(decodePhoneMessage({ t: "req", rid: "r", method: "TRACE", path: "/x" })).toBeUndefined()
    expect(decodePhoneMessage({ t: "resume", streams: { s: -1 }, pending: [] })).toBeUndefined()
  })

  it("makes RFC 9562 UUIDv7 ids", () => {
    const id = uuidv7({ now: 0x0192f0c47a00, random: new Uint8Array(10).fill(0xff) })
    expect(id).toBe("0192f0c4-7a00-7fff-bfff-ffffffffffff")
  })
})
