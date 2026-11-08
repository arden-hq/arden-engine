import { Stream } from "effect"

import {
  decodeSseFrameStreamEffect,
  decodeServerEventFramesEffect,
  decodeServerEventStreamEffect,
  decodeSseFramesEffect
} from "./sse-effect.js"
import { asyncIterableBoundary, runBoundary } from "../common/boundary.js"
import type { DecodedServerEventFrame, SseDecodeOptions, SseFrame } from "./contracts.js"

/** Parse a complete SSE buffer. Prefer `decodeServerEventStream` for live data. */
export function decodeSseFrames(
  input: string,
  options?: SseDecodeOptions
): ReadonlyArray<SseFrame> {
  return runBoundary(
    decodeSseFramesEffect(input, options),
    "Invalid SSE stream",
    "stream"
  ) as ReadonlyArray<SseFrame>
}

/** Decode a complete SSE buffer and validate each event payload. */
export function decodeServerEventStreamBuffer(
  input: string,
  options?: SseDecodeOptions
): ReadonlyArray<DecodedServerEventFrame> {
  return runBoundary(
    decodeServerEventFramesEffect(input, options),
    "Invalid server event stream",
    "stream"
  ) as ReadonlyArray<DecodedServerEventFrame>
}

/**
 * Decode a live SSE source. It accepts text or UTF-8 byte chunks and preserves
 * event ids, names, and decoded JSON data. Returning/closing the iterator
 * interrupts the underlying Effect stream and source.
 */
export function decodeServerEventStream(
  input: AsyncIterable<string | Uint8Array>,
  options?: SseDecodeOptions
): AsyncIterable<DecodedServerEventFrame> {
  const stream = Stream.toAsyncIterable(decodeServerEventStreamEffect(input, options))
  return asyncIterableBoundary(
    stream,
    "Invalid server event stream",
    "stream"
  ) as AsyncIterable<DecodedServerEventFrame>
}

/**
 * Decode a live SSE source into its frames without reading their payloads: a
 * stream whose data is not a server event (the relay's) frames the same way.
 */
export function decodeSseFrameStream(
  input: AsyncIterable<string | Uint8Array>,
  options?: SseDecodeOptions
): AsyncIterable<SseFrame> {
  const stream = Stream.toAsyncIterable(decodeSseFrameStreamEffect(input, options))
  return asyncIterableBoundary(stream, "Invalid SSE stream", "stream") as AsyncIterable<SseFrame>
}
