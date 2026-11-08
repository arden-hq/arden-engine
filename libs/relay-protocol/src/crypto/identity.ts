import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { randomBytes } from "@noble/hashes/utils.js"
import { concat, fromB64url, toB64url, utf8 } from "../encoding.js"

export interface Ed25519KeyPair {
  /** 32-byte seed (RFC 8032 private key); CryptoKit's `rawRepresentation`. */
  readonly secretKey: Uint8Array
  readonly publicKey: Uint8Array
}

export const generateEd25519 = (seed: Uint8Array = randomBytes(32)): Ed25519KeyPair => ({
  secretKey: seed,
  publicKey: ed25519.getPublicKey(seed)
})

/** Device id: the first 22 chars of b64url(sha256(ed_pub)). A Mac's id is also its relay `mac` id. */
export const deviceId = (edPublicKey: Uint8Array): string =>
  toB64url(sha256(edPublicKey)).slice(0, 22)

/** "arden-relay-auth/1" ‖ mac ‖ dev ‖ nonce (mac/dev as UTF-8, nonce raw 32 bytes). */
export const authMessage = (input: { mac: string; dev: string; nonce: Uint8Array }): Uint8Array =>
  concat(utf8("arden-relay-auth/1"), utf8(input.mac), utf8(input.dev), input.nonce)

/** "arden-add-device/1" ‖ dev ‖ ed_pub (dev as UTF-8, ed_pub raw 32 bytes). */
export const addDeviceMessage = (input: { dev: string; edPublicKey: Uint8Array }): Uint8Array =>
  concat(utf8("arden-add-device/1"), utf8(input.dev), input.edPublicKey)

/** "arden-remove-device/1" ‖ dev (UTF-8). */
export const removeDeviceMessage = (input: { dev: string }): Uint8Array =>
  concat(utf8("arden-remove-device/1"), utf8(input.dev))

/** "arden-leave-device/1" ‖ mac ‖ dev (UTF-8): a phone telling its Mac it is leaving. */
export const leaveDeviceMessage = (input: { mac: string; dev: string }): Uint8Array =>
  concat(utf8("arden-leave-device/1"), utf8(input.mac), utf8(input.dev))

export const sign = (message: Uint8Array, secretKey: Uint8Array): Uint8Array =>
  ed25519.sign(message, secretKey)

/** False on any malformed key or signature instead of throwing. */
export const verify = (
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean => {
  try {
    return ed25519.verify(signature, message, publicKey)
  } catch {
    return false
  }
}

/** b64url-encoded variant for header fields; false when any field is not valid base64url. */
export const verifyB64 = (input: {
  sig: string
  message: Uint8Array
  publicKey: string
}): boolean => {
  try {
    return verify(fromB64url(input.sig), input.message, fromB64url(input.publicKey))
  } catch {
    return false
  }
}

/** b64url(sha256(raw pair token)) — what the Mac posts in pair_offer. */
export const pairTokenHash = (token: Uint8Array): string => toB64url(sha256(token))

/**
 * The 6-digit code both screens show during pairing:
 * u32be(sha256("arden-pair-code/1" ‖ token ‖ phone ed_pub ‖ phone x_pub)[0..4]) mod 10^6,
 * zero-padded. It binds the phone's keys that crossed the relay to the QR's token.
 */
export const pairCode = (input: {
  token: Uint8Array
  phoneEdPublicKey: Uint8Array
  phoneXPublicKey: Uint8Array
}): string => {
  const digest = sha256(
    concat(utf8("arden-pair-code/1"), input.token, input.phoneEdPublicKey, input.phoneXPublicKey)
  )
  const value =
    (((digest[0] ?? 0) << 24) |
      ((digest[1] ?? 0) << 16) |
      ((digest[2] ?? 0) << 8) |
      (digest[3] ?? 0)) >>>
    0
  return String(value % 1_000_000).padStart(6, "0")
}
