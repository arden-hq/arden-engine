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

export const deviceId = (edPublicKey: Uint8Array): string =>
  toB64url(sha256(edPublicKey)).slice(0, 22)

export const authMessage = (input: { mac: string; dev: string; nonce: Uint8Array }): Uint8Array =>
  concat(utf8("arden-relay-auth/1"), utf8(input.mac), utf8(input.dev), input.nonce)

export const addDeviceMessage = (input: { dev: string; edPublicKey: Uint8Array }): Uint8Array =>
  concat(utf8("arden-add-device/1"), utf8(input.dev), input.edPublicKey)

export const removeDeviceMessage = (input: { dev: string }): Uint8Array =>
  concat(utf8("arden-remove-device/1"), utf8(input.dev))

export const leaveDeviceMessage = (input: { mac: string; dev: string }): Uint8Array =>
  concat(utf8("arden-leave-device/1"), utf8(input.mac), utf8(input.dev))

export const sign = (message: Uint8Array, secretKey: Uint8Array): Uint8Array =>
  ed25519.sign(message, secretKey)

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

export const pairTokenHash = (token: Uint8Array): string => toB64url(sha256(token))

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
