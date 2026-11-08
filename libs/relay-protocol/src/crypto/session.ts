import { chacha20poly1305 } from "@noble/ciphers/chacha.js"
import { x25519 } from "@noble/curves/ed25519.js"
import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { randomBytes } from "@noble/hashes/utils.js"
import { concat, utf8 } from "../encoding.js"

export const BodyKind = { Frame: 0x01, Sealed: 0x02, Handshake: 0x7b } as const

export type CryptoFailure = "low_order" | "auth" | "closed" | "malformed" | "counter_overflow"

export class RelayCryptoError extends Error {
  readonly reason: CryptoFailure
  constructor(reason: CryptoFailure, message: string) {
    super(message)
    this.name = "RelayCryptoError"
    this.reason = reason
  }
}

export interface X25519KeyPair {
  /** 32 raw bytes; CryptoKit's `Curve25519.KeyAgreement.PrivateKey.rawRepresentation`. */
  readonly secretKey: Uint8Array
  readonly publicKey: Uint8Array
}

export const generateX25519 = (secretKey: Uint8Array = randomBytes(32)): X25519KeyPair => ({
  secretKey,
  publicKey: x25519.getPublicKey(secretKey)
})

/**
 * AEAD associated data for session frames and sealed blobs. The relay
 * rewrites `{to}` into `{from}`, so raw header bytes cannot be the AAD; both
 * ends bind the two device ids instead (a Mac's device id is its mac id):
 * UTF8("arden-e2e/1 aad") ‖ 0x00 ‖ UTF8(senderDev) ‖ 0x00 ‖ UTF8(receiverDev).
 */
export const bodyAad = (input: { sender: string; receiver: string }): Uint8Array =>
  concat(
    utf8("arden-e2e/1 aad"),
    new Uint8Array([0]),
    utf8(input.sender),
    new Uint8Array([0]),
    utf8(input.receiver)
  )

const dh = (secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array => {
  try {
    const shared = x25519.getSharedSecret(secretKey, publicKey)
    if (shared.every((byte) => byte === 0)) throw new Error("all-zero shared secret")
    return shared
  } catch (cause) {
    throw new RelayCryptoError("low_order", `X25519 rejected the peer key: ${String(cause)}`)
  }
}

export interface SessionKeys {
  /** phone → Mac */
  readonly p2m: Uint8Array
  /** Mac → phone */
  readonly m2p: Uint8Array
}

const deriveSessionKeys = (input: {
  dh1: Uint8Array
  dh2: Uint8Array
  dh3: Uint8Array
  phoneStatic: Uint8Array
  macStatic: Uint8Array
  phoneEphemeral: Uint8Array
  macEphemeral: Uint8Array
}): SessionKeys => {
  const salt = sha256(
    concat(
      utf8("arden-e2e/1"),
      input.phoneStatic,
      input.macStatic,
      input.phoneEphemeral,
      input.macEphemeral
    )
  )
  const okm = hkdf(
    sha256,
    concat(input.dh1, input.dh2, input.dh3),
    salt,
    utf8("arden-e2e/1 keys"),
    64
  )
  return { p2m: okm.slice(0, 32), m2p: okm.slice(32, 64) }
}

/** ikm = DH(eP,eM) ‖ DH(eP,SM) ‖ DH(SP,eM), computed on the phone. */
export const phoneSessionKeys = (input: {
  phoneStatic: X25519KeyPair
  phoneEphemeral: X25519KeyPair
  macStaticPublic: Uint8Array
  macEphemeralPublic: Uint8Array
}): SessionKeys =>
  deriveSessionKeys({
    dh1: dh(input.phoneEphemeral.secretKey, input.macEphemeralPublic),
    dh2: dh(input.phoneEphemeral.secretKey, input.macStaticPublic),
    dh3: dh(input.phoneStatic.secretKey, input.macEphemeralPublic),
    phoneStatic: input.phoneStatic.publicKey,
    macStatic: input.macStaticPublic,
    phoneEphemeral: input.phoneEphemeral.publicKey,
    macEphemeral: input.macEphemeralPublic
  })

/** The same keys, computed on the Mac. */
export const macSessionKeys = (input: {
  macStatic: X25519KeyPair
  macEphemeral: X25519KeyPair
  phoneStaticPublic: Uint8Array
  phoneEphemeralPublic: Uint8Array
}): SessionKeys =>
  deriveSessionKeys({
    dh1: dh(input.macEphemeral.secretKey, input.phoneEphemeralPublic),
    dh2: dh(input.macStatic.secretKey, input.phoneEphemeralPublic),
    dh3: dh(input.macEphemeral.secretKey, input.phoneStaticPublic),
    phoneStatic: input.phoneStaticPublic,
    macStatic: input.macStatic.publicKey,
    phoneEphemeral: input.phoneEphemeralPublic,
    macEphemeral: input.macEphemeral.publicKey
  })

const frameNonce = (counter: number): Uint8Array => {
  const nonce = new Uint8Array(12)
  const view = new DataView(nonce.buffer)
  view.setBigUint64(4, BigInt(counter))
  return nonce
}

/**
 * One direction pair of a live session. Counters are implicit (never on the
 * wire) and start at 0; a frame that fails to open — tampered, replayed,
 * reordered or dropped — closes the cipher for good, and the phone reconnects
 * and runs a new handshake.
 */
export class SessionCipher {
  readonly #sendKey: Uint8Array
  readonly #receiveKey: Uint8Array
  #sendCounter = 0
  #receiveCounter = 0
  #closed = false

  private constructor(sendKey: Uint8Array, receiveKey: Uint8Array) {
    this.#sendKey = sendKey
    this.#receiveKey = receiveKey
  }

  static forPhone(keys: SessionKeys): SessionCipher {
    return new SessionCipher(keys.p2m, keys.m2p)
  }

  static forMac(keys: SessionKeys): SessionCipher {
    return new SessionCipher(keys.m2p, keys.p2m)
  }

  get closed(): boolean {
    return this.#closed
  }

  seal(plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
    this.#assertOpen()
    if (this.#sendCounter >= Number.MAX_SAFE_INTEGER) {
      this.#closed = true
      throw new RelayCryptoError("counter_overflow", "send counter exhausted")
    }
    const sealed = chacha20poly1305(this.#sendKey, frameNonce(this.#sendCounter), aad).encrypt(
      plaintext
    )
    this.#sendCounter += 1
    return concat(new Uint8Array([BodyKind.Frame]), sealed)
  }

  open(body: Uint8Array, aad: Uint8Array): Uint8Array {
    this.#assertOpen()
    if (body[0] !== BodyKind.Frame || body.length < 17) {
      this.#closed = true
      throw new RelayCryptoError("malformed", "not a session frame")
    }
    try {
      const plaintext = chacha20poly1305(
        this.#receiveKey,
        frameNonce(this.#receiveCounter),
        aad
      ).decrypt(body.subarray(1))
      this.#receiveCounter += 1
      return plaintext
    } catch {
      this.#closed = true
      throw new RelayCryptoError("auth", `frame ${this.#receiveCounter} failed to authenticate`)
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new RelayCryptoError("closed", "session is closed; run a new handshake")
  }
}

const sealKey = (input: {
  dh1: Uint8Array
  dh2: Uint8Array
  ephemeral: Uint8Array
  phoneStatic: Uint8Array
  macStatic: Uint8Array
}): Uint8Array =>
  hkdf(
    sha256,
    concat(input.dh1, input.dh2),
    sha256(concat(utf8("arden-seal/1"), input.ephemeral, input.phoneStatic, input.macStatic)),
    utf8("seal"),
    32
  )

/** key = HKDF(DH(eph,SM) ‖ DH(SP,SM), salt = sha256("arden-seal/1" ‖ eph ‖ SP ‖ SM), "seal", 32). */
export const sealQueued = (input: {
  phoneStatic: X25519KeyPair
  macStaticPublic: Uint8Array
  plaintext: Uint8Array
  aad: Uint8Array
  ephemeral?: X25519KeyPair
}): Uint8Array => {
  const ephemeral = input.ephemeral ?? generateX25519()
  const key = sealKey({
    dh1: dh(ephemeral.secretKey, input.macStaticPublic),
    dh2: dh(input.phoneStatic.secretKey, input.macStaticPublic),
    ephemeral: ephemeral.publicKey,
    phoneStatic: input.phoneStatic.publicKey,
    macStatic: input.macStaticPublic
  })
  const sealed = chacha20poly1305(key, new Uint8Array(12), input.aad).encrypt(input.plaintext)
  return concat(new Uint8Array([BodyKind.Sealed]), ephemeral.publicKey, sealed)
}

export const openQueued = (input: {
  macStatic: X25519KeyPair
  phoneStaticPublic: Uint8Array
  body: Uint8Array
  aad: Uint8Array
}): Uint8Array => {
  if (input.body[0] !== BodyKind.Sealed || input.body.length < 1 + 32 + 16) {
    throw new RelayCryptoError("malformed", "not a sealed blob")
  }
  const ephemeral = input.body.slice(1, 33)
  const key = sealKey({
    dh1: dh(input.macStatic.secretKey, ephemeral),
    dh2: dh(input.macStatic.secretKey, input.phoneStaticPublic),
    ephemeral,
    phoneStatic: input.phoneStaticPublic,
    macStatic: input.macStatic.publicKey
  })
  try {
    return chacha20poly1305(key, new Uint8Array(12), input.aad).decrypt(input.body.subarray(33))
  } catch {
    throw new RelayCryptoError("auth", "sealed blob failed to authenticate")
  }
}
