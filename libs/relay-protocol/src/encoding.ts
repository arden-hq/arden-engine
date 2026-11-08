declare const TextEncoder: new () => { encode(input: string): Uint8Array }
declare const TextDecoder: new (
  label: string,
  options: { fatal: boolean }
) => { decode(input: Uint8Array): string }

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export const utf8 = (text: string): Uint8Array => encoder.encode(text)

/** Throws on invalid UTF-8. */
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes)

export const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

export const fromHex = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error("invalid hex")
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const lookup = new Map(Array.from(alphabet, (char, index) => [char, index]))

/** RFC 4648 §5 base64url without padding — the only base64 on the wire. */
export const toB64url = (bytes: Uint8Array): string => {
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const chunk = (a << 16) | (b << 8) | c
    const chars = Math.min(bytes.length - i, 3) + 1
    for (let j = 0; j < chars; j++) out += alphabet[(chunk >> (18 - j * 6)) & 63]
  }
  return out
}

/** Strict: rejects padding, the standard alphabet's `+`/`/` and non-canonical tails. */
export const fromB64url = (text: string): Uint8Array => {
  if (text.length % 4 === 1) throw new Error("invalid base64url")
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let bits = 0
  let value = 0
  let index = 0
  for (const char of text) {
    const digit = lookup.get(char)
    if (digit === undefined) throw new Error("invalid base64url")
    value = (value << 6) | digit
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[index++] = (value >> bits) & 0xff
    }
  }
  if ((value & ((1 << bits) - 1)) !== 0) throw new Error("invalid base64url")
  return out
}
