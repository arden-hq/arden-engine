import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  bodyAad,
  fromB64url,
  generateX25519,
  macSessionKeys,
  openQueued,
  phoneSessionKeys,
  RelayCryptoError,
  SessionCipher,
  sealQueued,
  toB64url,
  utf8,
  verifyB64
} from "@arden-hq/relay-protocol"

const session = () => {
  const SP = generateX25519()
  const SM = generateX25519()
  const eP = generateX25519()
  const eM = generateX25519()
  const keys = phoneSessionKeys({
    phoneStatic: SP,
    phoneEphemeral: eP,
    macStaticPublic: SM.publicKey,
    macEphemeralPublic: eM.publicKey
  })
  return { SP, SM, phone: SessionCipher.forPhone(keys), mac: SessionCipher.forMac(keys) }
}

const aad = bodyAad({ sender: "pppppppppppppppppppppp", receiver: "mmmmmmmmmmmmmmmmmmmmmm" })

const failure = (run: () => unknown): string | undefined => {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof RelayCryptoError ? error.reason : "other"
  }
}

describe("session cipher", () => {
  it("rejects a frame out of order and stays closed", () => {
    const { phone, mac } = session()
    phone.seal(utf8("first"), aad)
    const second = phone.seal(utf8("second"), aad)
    expect(failure(() => mac.open(second, aad))).toBe("auth")
    expect(mac.closed).toBe(true)
    expect(failure(() => mac.open(second, aad))).toBe("closed")
  })

  it("rejects a replayed frame", () => {
    const { phone, mac } = session()
    const first = phone.seal(utf8("first"), aad)
    mac.open(first, aad)
    expect(failure(() => mac.open(first, aad))).toBe("auth")
  })

  it("rejects tampered aad and tampered ciphertext", () => {
    const tamperedAad = session()
    const frame = tamperedAad.phone.seal(utf8("hello"), aad)
    const otherAad = bodyAad({
      sender: "pppppppppppppppppppppp",
      receiver: "xxxxxxxxxxxxxxxxxxxxxx"
    })
    expect(failure(() => tamperedAad.mac.open(frame, otherAad))).toBe("auth")

    const tamperedBody = session()
    const body = tamperedBody.phone.seal(utf8("hello"), aad)
    body[3] = (body[3] ?? 0) ^ 1
    expect(failure(() => tamperedBody.mac.open(body, aad))).toBe("auth")
  })

  it("keeps the two directions independent", () => {
    const { phone, mac } = session()
    const fromPhone = phone.seal(utf8("p0"), aad)
    const fromMac = mac.seal(utf8("m0"), aad)
    expect([mac.open(fromPhone, aad), phone.open(fromMac, aad)]).toEqual([utf8("p0"), utf8("m0")])
  })

  it("rejects an all-zero (low-order) DH in the handshake and in sealing", () => {
    const zero = new Uint8Array(32)
    const SP = generateX25519()
    expect(
      failure(() =>
        phoneSessionKeys({
          phoneStatic: SP,
          phoneEphemeral: generateX25519(),
          macStaticPublic: generateX25519().publicKey,
          macEphemeralPublic: zero
        })
      )
    ).toBe("low_order")
    expect(
      failure(() =>
        macSessionKeys({
          macStatic: generateX25519(),
          macEphemeral: generateX25519(),
          phoneStaticPublic: zero,
          phoneEphemeralPublic: generateX25519().publicKey
        })
      )
    ).toBe("low_order")
    expect(
      failure(() =>
        sealQueued({ phoneStatic: SP, macStaticPublic: zero, plaintext: utf8("x"), aad })
      )
    ).toBe("low_order")
  })
})

describe("sealed blobs", () => {
  it("opens with the right keys and aad only", () => {
    const { SP, SM } = session()
    const body = sealQueued({
      phoneStatic: SP,
      macStaticPublic: SM.publicKey,
      plaintext: utf8("queued"),
      aad
    })
    expect(openQueued({ macStatic: SM, phoneStaticPublic: SP.publicKey, body, aad })).toEqual(
      utf8("queued")
    )
    const otherAad = bodyAad({
      sender: "qqqqqqqqqqqqqqqqqqqqqq",
      receiver: "mmmmmmmmmmmmmmmmmmmmmm"
    })
    expect(
      failure(() =>
        openQueued({ macStatic: SM, phoneStaticPublic: SP.publicKey, body, aad: otherAad })
      )
    ).toBe("auth")
    const impostor = generateX25519()
    expect(
      failure(() => openQueued({ macStatic: SM, phoneStaticPublic: impostor.publicKey, body, aad }))
    ).toBe("auth")
    expect(
      failure(() =>
        openQueued({ macStatic: SM, phoneStaticPublic: SP.publicKey, body: body.slice(0, 20), aad })
      )
    ).toBe("malformed")
  })
})

const decodedOrUndefined = (text: string): Uint8Array | undefined => {
  try {
    return fromB64url(text)
  } catch {
    return undefined
  }
}

describe("base64url", () => {
  it("round-trips any bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 40 }), (bytes) => {
        expect(fromB64url(toB64url(bytes))).toEqual(bytes)
      })
    )
  })

  it("accepts only the canonical spelling: padding, the standard alphabet and loose tails throw", () => {
    const char = fc.constantFrom(
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=+/"
    )
    fc.assert(
      fc.property(fc.string({ unit: char, maxLength: 12 }), (text) => {
        const decoded = decodedOrUndefined(text)
        if (decoded !== undefined) expect(toB64url(decoded)).toBe(text)
      }),
      { examples: [["AA=="], ["+/8"], ["AB"]] }
    )
  })

  it("verifyB64 answers false for malformed input instead of throwing", () => {
    expect(verifyB64({ sig: "!!", message: utf8("m"), publicKey: "AA" })).toBe(false)
  })
})
