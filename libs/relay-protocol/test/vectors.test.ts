import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  addDeviceMessage,
  authMessage,
  bodyAad,
  decodeFrame,
  deviceId,
  encodeFrame,
  fromHex,
  fromUtf8,
  generateEd25519,
  generateX25519,
  macSessionKeys,
  openQueued,
  pairCode,
  pairTokenHash,
  phoneSessionKeys,
  removeDeviceMessage,
  SessionCipher,
  sealQueued,
  toHex,
  utf8,
  verify
} from "@arden-hq/relay-protocol"

const vectors: unknown = JSON.parse(
  readFileSync(new URL("../test-vectors.json", import.meta.url), "utf8")
)

const at = (path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        typeof node === "object" && node !== null ? Reflect.get(node, key) : undefined,
      vectors
    )

const field = (path: string): string => {
  const value = at(path)
  if (typeof value !== "string") throw new Error(`missing vector ${path}`)
  return value
}
const hex = (path: string): Uint8Array => fromHex(field(path))

const frameList = (direction: "p2m" | "m2p") => {
  const list = at(`frames.${direction}`)
  if (!Array.isArray(list)) throw new Error("missing frames")
  return list.map((_, index) => ({
    plaintext: hex(`frames.${direction}.${index}.plaintext`),
    body: hex(`frames.${direction}.${index}.body`)
  }))
}

describe("test vectors", () => {
  const SP = generateX25519(hex("handshake.phone_static_secret"))
  const SM = generateX25519(hex("handshake.mac_static_secret"))
  const eP = generateX25519(hex("handshake.phone_ephemeral_secret"))
  const eM = generateX25519(hex("handshake.mac_ephemeral_secret"))
  const phoneKeys = phoneSessionKeys({
    phoneStatic: SP,
    phoneEphemeral: eP,
    macStaticPublic: SM.publicKey,
    macEphemeralPublic: eM.publicKey
  })
  const macKeys = macSessionKeys({
    macStatic: SM,
    macEphemeral: eM,
    phoneStaticPublic: SP.publicKey,
    phoneEphemeralPublic: eP.publicKey
  })

  it("derives device ids and public keys from the seeds", () => {
    const mac = generateEd25519(hex("identity.mac_ed_secret"))
    const phone = generateEd25519(hex("identity.phone_ed_secret"))
    expect({
      mac_ed_public: toHex(mac.publicKey),
      mac_id: deviceId(mac.publicKey),
      phone_ed_public: toHex(phone.publicKey),
      phone_dev: deviceId(phone.publicKey)
    }).toEqual({
      mac_ed_public: field("identity.mac_ed_public"),
      mac_id: field("identity.mac_id"),
      phone_ed_public: field("identity.phone_ed_public"),
      phone_dev: field("identity.phone_dev")
    })
  })

  it("builds the signed messages and verifies their signatures", () => {
    const auth = authMessage({
      mac: field("auth.mac"),
      dev: field("auth.dev"),
      nonce: hex("auth.nonce")
    })
    const add = addDeviceMessage({
      dev: field("add_device.dev"),
      edPublicKey: hex("add_device.ed_public")
    })
    const remove = removeDeviceMessage({ dev: field("remove_device.dev") })
    expect([toHex(auth), toHex(add), toHex(remove)]).toEqual([
      field("auth.message"),
      field("add_device.message"),
      field("remove_device.message")
    ])
    expect([
      verify(hex("auth.signature"), auth, hex("auth.signer_public")),
      verify(hex("add_device.signature"), add, hex("add_device.signer_public")),
      verify(hex("remove_device.signature"), remove, hex("remove_device.signer_public")),
      verify(hex("auth.signature"), add, hex("auth.signer_public"))
    ]).toEqual([true, true, true, false])
  })

  it("derives the pairing hash and code", () => {
    const token = hex("pairing.token")
    expect({
      hash: pairTokenHash(token),
      code: pairCode({
        token,
        phoneEdPublicKey: hex("pairing.phone_ed_public"),
        phoneXPublicKey: hex("pairing.phone_x_public")
      })
    }).toEqual({ hash: field("pairing.token_hash_b64url"), code: field("pairing.code") })
  })

  it("derives the same session keys on both ends", () => {
    expect({ p2m: toHex(phoneKeys.p2m), m2p: toHex(phoneKeys.m2p) }).toEqual({
      p2m: field("handshake.k_p2m"),
      m2p: field("handshake.k_m2p")
    })
    expect(macKeys).toEqual(phoneKeys)
    expect(toHex(phoneKeys.p2m) + toHex(phoneKeys.m2p)).toBe(field("handshake.okm"))
  })

  it("seals and opens the first frames in each direction", () => {
    const mac = field("frames.mac_id")
    const phone = field("frames.phone_dev")
    const p2mAad = bodyAad({ sender: phone, receiver: mac })
    const m2pAad = bodyAad({ sender: mac, receiver: phone })
    expect([toHex(p2mAad), toHex(m2pAad)]).toEqual([
      field("frames.p2m_aad"),
      field("frames.m2p_aad")
    ])

    const phoneSender = SessionCipher.forPhone(phoneKeys)
    const macReceiver = SessionCipher.forMac(macKeys)
    for (const frame of frameList("p2m")) {
      expect(toHex(phoneSender.seal(frame.plaintext, p2mAad))).toBe(toHex(frame.body))
      expect(toHex(macReceiver.open(frame.body, p2mAad))).toBe(toHex(frame.plaintext))
    }
    const macSender = SessionCipher.forMac(macKeys)
    const phoneReceiver = SessionCipher.forPhone(phoneKeys)
    for (const frame of frameList("m2p")) {
      expect(toHex(macSender.seal(frame.plaintext, m2pAad))).toBe(toHex(frame.body))
      expect(toHex(phoneReceiver.open(frame.body, m2pAad))).toBe(toHex(frame.plaintext))
    }
  })

  it("reproduces and opens the sealed blob", () => {
    const ephemeral = generateX25519(hex("sealed.ephemeral_secret"))
    const body = sealQueued({
      phoneStatic: SP,
      macStaticPublic: SM.publicKey,
      plaintext: hex("sealed.plaintext"),
      aad: hex("sealed.aad"),
      ephemeral
    })
    expect(toHex(body)).toBe(field("sealed.body"))
    const opened = openQueued({
      macStatic: SM,
      phoneStaticPublic: SP.publicKey,
      body: hex("sealed.body"),
      aad: hex("sealed.aad")
    })
    expect(fromUtf8(opened)).toBe(field("sealed.plaintext_utf8"))
  })

  it("encodes the relay frame", () => {
    const header: unknown = JSON.parse(field("relay_frame.header_utf8"))
    const decoded = decodeFrame(hex("relay_frame.frame"))
    expect(decoded).toEqual({
      ok: true,
      header,
      headerBytes: utf8(field("relay_frame.header_utf8")),
      body: hex("relay_frame.body")
    })
    if (!decoded.ok) return
    expect(toHex(encodeFrame(decoded.header, decoded.body))).toBe(field("relay_frame.frame"))
  })
})
