import { Channel, Data, Effect, Option, Schema, Stream } from "effect"
import {
  type AnyEvent,
  encoder as sseEncoder,
  EventEncoded,
  makeParser,
  type SseError,
  type Retry
} from "effect/unstable/encoding/Sse"
import { ServerEventSchema, isKnownServerEventType } from "../events/schema.js"
import {
  ANONYMOUS_FRAME,
  SSE_DECODE_DEFAULTS,
  SSE_FRAME_ID,
  sseFrameId,
  type DecodedServerEventFrame,
  type EncodeServerEventOptions,
  type SseDecodeOptions,
  type SseFrame
} from "./contracts.js"
import type { ServerEvent } from "../events/contracts.js"
import { notifyRetry, parserOptions } from "./retry.js"

class EventTypeMismatch extends Data.TaggedError("EventTypeMismatch")<{
  readonly frameEvent: string
  readonly payloadType: string
}> {}

class EventSequenceMismatch extends Data.TaggedError("EventSequenceMismatch")<{
  readonly frameId: string
  readonly payloadSequence: number
}> {}

class InvalidSseId extends Data.TaggedError("InvalidSseId")<{
  readonly id: string
}> {}

class StreamInputError extends Data.TaggedError("StreamInputError")<{
  readonly cause: unknown
}> {}

type SseFrameFailure = StreamInputError | SseError | Schema.SchemaError

const toFrame = (value: Schema.Schema.Type<typeof EventEncoded>): SseFrame => ({
  id: sseFrameId(value.id),
  event: value.event,
  data: value.data
})

const validateServerEventFrame = Effect.fn("validateServerEventFrame")(function* (input: {
  readonly id: SseFrame["id"]
  readonly event: string
  readonly data: ServerEvent
}): Effect.fn.Return<DecodedServerEventFrame, EventTypeMismatch | EventSequenceMismatch> {
  if (input.event !== input.data.type) {
    return yield* new EventTypeMismatch({
      frameEvent: input.event,
      payloadType: input.data.type
    })
  }
  if (
    input.id.kind === SSE_FRAME_ID.identified &&
    input.data.seq !== undefined &&
    input.id.id !== String(input.data.seq)
  ) {
    return yield* new EventSequenceMismatch({
      frameId: input.id.id,
      payloadSequence: input.data.seq
    })
  }
  return { id: input.id, event: input.data.type, data: input.data }
})

const JsonValueSchema = Schema.fromJsonString(Schema.Unknown)

const unknownEventType = (payload: unknown): string | undefined =>
  typeof payload === "object" &&
  payload !== null &&
  "type" in payload &&
  typeof payload.type === "string" &&
  !isKnownServerEventType(payload.type)
    ? payload.type
    : undefined

const decodeServerEventFrame = Effect.fn("decodeServerEventFrame")(function* (
  frame: SseFrame,
  options: SseDecodeOptions
) {
  const payload = yield* Schema.decodeUnknownEffect(JsonValueSchema)(frame.data)
  const unknown = unknownEventType(payload)
  if (unknown !== undefined) {
    options.onUnknownEvent({ id: frame.id, event: frame.event, type: unknown })
    return Option.none()
  }
  const data = yield* Schema.decodeUnknownEffect(ServerEventSchema)(payload)
  return Option.some(yield* validateServerEventFrame({ id: frame.id, event: frame.event, data }))
})

/** Decode a complete SSE buffer using Effect's standards-compliant parser. */
export const decodeSseFramesEffect = Effect.fn("decodeSseFramesEffect")(function* (
  input: string,
  options: SseDecodeOptions = SSE_DECODE_DEFAULTS
) {
  const parsed: Array<EventEncoded> = []
  const retries: Array<Retry> = []
  const parser = makeParser((value) => {
    if (value._tag === "Retry") {
      retries.push(value)
    } else {
      parsed.push(value)
    }
  }, parserOptions(options))
  const parserError = parser.feed(input)
  if (parserError !== undefined) {
    return yield* Effect.fail(parserError)
  }
  const flushError = parser.feed("\n\n")
  if (flushError !== undefined) {
    return yield* Effect.fail(flushError)
  }
  for (const retry of retries) yield* notifyRetry(options, retry)

  const frames: Array<SseFrame> = []
  for (const value of parsed) {
    frames.push(toFrame(yield* Schema.decodeUnknownEffect(EventEncoded)(value)))
  }
  return frames
})

export const decodeServerEventFramesEffect = Effect.fn("decodeServerEventFramesEffect")(function* (
  input: string,
  options: SseDecodeOptions = SSE_DECODE_DEFAULTS
) {
  const frames = yield* decodeSseFramesEffect(input, options)
  const decoded: Array<DecodedServerEventFrame> = []
  for (const frame of frames) {
    const event = yield* decodeServerEventFrame(frame, options)
    if (Option.isSome(event)) decoded.push(event.value)
  }
  return decoded
})

export const encodeServerEventFrameEffect = Effect.fn("encodeServerEventFrameEffect")(function* (
  eventValue: ServerEvent,
  options: EncodeServerEventOptions = { id: ANONYMOUS_FRAME }
) {
  const id = options.id.kind === SSE_FRAME_ID.identified ? options.id.id : undefined
  if (id?.includes("\0") || id?.includes("\r") || id?.includes("\n")) {
    return yield* Effect.fail(new InvalidSseId({ id }))
  }
  const eventData = yield* Schema.decodeUnknownEffect(ServerEventSchema)(eventValue)
  const data = JSON.stringify(eventData)
  return sseEncoder.write({
    _tag: "Event",
    id,
    event: eventData.type,
    data
  })
})

/** A live SSE source as its frames (`id`, `event`, `data`), lazily, with cancellation owned by the stream. */
export const decodeSseFrameStreamEffect = (
  input: AsyncIterable<string | Uint8Array>,
  options: SseDecodeOptions = SSE_DECODE_DEFAULTS
): Stream.Stream<SseFrame, SseFrameFailure> => {
  const encoder = new TextEncoder()
  const bytes = Stream.concat(
    Stream.fromAsyncIterable(input, (cause) => new StreamInputError({ cause })).pipe(
      Stream.map((chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk))
    ),
    Stream.succeed(encoder.encode("\n\n"))
  )
  const text = bytes.pipe(Stream.pipeThroughChannel(Channel.decodeText()))
  return Stream.suspend(() => {
    const pending: Array<AnyEvent> = []
    const parser = makeParser((value) => pending.push(value), parserOptions(options))
    return text.pipe(
      Stream.mapEffect(
        Effect.fn("SseFrameStream.chunk")(function* (chunk) {
          const error = parser.feed(chunk)
          if (error !== undefined) return yield* Effect.fail(error)
          return pending.splice(0)
        })
      ),
      Stream.flatMap((values) => Stream.fromIterable(values)),
      Stream.flatMap((value) => {
        if (value._tag === "Retry") {
          return Stream.fromEffect(notifyRetry(options, value)).pipe(Stream.drain)
        }
        return Stream.fromEffect(
          Schema.decodeUnknownEffect(EventEncoded)(value).pipe(Effect.map(toFrame))
        )
      })
    )
  })
}

/** Decode a live SSE source lazily, with cancellation owned by the stream. */
export const decodeServerEventStreamEffect = (
  input: AsyncIterable<string | Uint8Array>,
  options: SseDecodeOptions = SSE_DECODE_DEFAULTS
): Stream.Stream<
  DecodedServerEventFrame,
  SseFrameFailure | EventTypeMismatch | EventSequenceMismatch
> =>
  decodeSseFrameStreamEffect(input, options).pipe(
    Stream.flatMap((frame) =>
      Stream.fromEffect(decodeServerEventFrame(frame, options)).pipe(
        Stream.flatMap((event) =>
          Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty
        )
      )
    )
  )
