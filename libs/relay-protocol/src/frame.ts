import { concat, fromUtf8, utf8 } from "./encoding.js"
import type { ClientHeader, RelayHeader } from "./headers.js"
import { isRecord } from "@arden-hq/std/json"

export const FRAME_VERSION = 1
export const MAX_FRAME_BYTES = 256 * 1024
export const MAX_HEADER_BYTES = 8 * 1024

export interface DecodedFrame {
  readonly ok: true
  /** Parsed JSON object with a string `t`; narrow it with parseClientHeader/parseRelayHeader. */
  readonly header: { readonly t: string } & Record<string, unknown>
  readonly headerBytes: Uint8Array
  readonly body: Uint8Array
}

export interface FrameError {
  readonly ok: false
  readonly reason: "too_large" | "bad_version" | "truncated" | "bad_header"
}

export const encodeFrame = (
  header: ClientHeader | RelayHeader | DecodedFrame["header"],
  body: Uint8Array = new Uint8Array()
): Uint8Array => {
  const headerBytes = utf8(JSON.stringify(header))
  if (headerBytes.length > MAX_HEADER_BYTES)
    throw new Error(`frame header over ${MAX_HEADER_BYTES} bytes`)
  const prefix = new Uint8Array([FRAME_VERSION, headerBytes.length >> 8, headerBytes.length & 0xff])
  const frame = concat(prefix, headerBytes, body)
  if (frame.length > MAX_FRAME_BYTES) throw new Error(`frame over ${MAX_FRAME_BYTES} bytes`)
  return frame
}

export const decodeFrame = (frame: Uint8Array): DecodedFrame | FrameError => {
  if (frame.length > MAX_FRAME_BYTES) return { ok: false, reason: "too_large" }
  if (frame.length < 3) return { ok: false, reason: "truncated" }
  if (frame[0] !== FRAME_VERSION) return { ok: false, reason: "bad_version" }
  const headerLength = ((frame[1] ?? 0) << 8) | (frame[2] ?? 0)
  if (headerLength > MAX_HEADER_BYTES) return { ok: false, reason: "bad_header" }
  if (frame.length < 3 + headerLength) return { ok: false, reason: "truncated" }
  const headerBytes = frame.slice(3, 3 + headerLength)
  const header = parseJsonObject(headerBytes)
  if (header === undefined) return { ok: false, reason: "bad_header" }
  const t = header["t"]
  if (typeof t !== "string") return { ok: false, reason: "bad_header" }
  return { ok: true, header: { ...header, t }, headerBytes, body: frame.slice(3 + headerLength) }
}

const parseJsonObject = (bytes: Uint8Array): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(fromUtf8(bytes))
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}
