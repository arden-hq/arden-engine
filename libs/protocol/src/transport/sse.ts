import { Stream } from "effect"

import {
  decodeSseFrameStreamEffect,
  decodeServerEventFramesEffect,
  decodeServerEventStreamEffect,
  decodeSseFramesEffect
} from "./sse-effect.js"
import { asyncIterableBoundary, runBoundary } from "../common/boundary.js"
import type { DecodedServerEventFrame, SseDecodeOptions, SseFrame } from "./contracts.js"

export function decodeSseFrames(
  input: string,
  options?: SseDecodeOptions
): ReadonlyArray<SseFrame> {
  return runBoundary(decodeSseFramesEffect(input, options), "Invalid SSE stream", "stream")
}

export function decodeServerEventStreamBuffer(
  input: string,
  options?: SseDecodeOptions
): ReadonlyArray<DecodedServerEventFrame> {
  return runBoundary(
    decodeServerEventFramesEffect(input, options),
    "Invalid server event stream",
    "stream"
  )
}

export function decodeServerEventStream(
  input: AsyncIterable<string | Uint8Array>,
  options?: SseDecodeOptions
): AsyncIterable<DecodedServerEventFrame> {
  const stream = Stream.toAsyncIterable(decodeServerEventStreamEffect(input, options))
  return asyncIterableBoundary(stream, "Invalid server event stream", "stream")
}

export function decodeSseFrameStream(
  input: AsyncIterable<string | Uint8Array>,
  options?: SseDecodeOptions
): AsyncIterable<SseFrame> {
  const stream = Stream.toAsyncIterable(decodeSseFrameStreamEffect(input, options))
  return asyncIterableBoundary(stream, "Invalid SSE stream", "stream")
}
