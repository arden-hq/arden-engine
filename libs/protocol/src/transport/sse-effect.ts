import { Channel, Data, Effect, Option, Schema, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import { ServerEventSchema, isKnownServerEventType } from "../events/schema.js"
import type { EncodeServerEventOptions, SseDecodeOptions } from "./contracts.js"
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

const validateServerEventFrame = Effect.fn("validateServerEventFrame")(function* (input: {
  readonly id?: string
  readonly event: string
  readonly data: ServerEvent
}) {
  if (input.event !== input.data.type) {
    return yield* new EventTypeMismatch({
      frameEvent: input.event,
      payloadType: input.data.type
    })
  }
  if (
    input.id !== undefined &&
    input.data.seq !== undefined &&
    input.id !== String(input.data.seq)
  ) {
    return yield* new EventSequenceMismatch({
      frameId: input.id,
      payloadSequence: input.data.seq
    })
  }
  return input.id === undefined
    ? { event: input.data.type, data: input.data }
    : { id: input.id, event: input.data.type, data: input.data }
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
  frame: { readonly id?: string | undefined; readonly event: string; readonly data: string },
  options?: SseDecodeOptions
) {
  const payload = yield* Schema.decodeUnknownEffect(JsonValueSchema)(frame.data)
  const unknown = unknownEventType(payload)
  if (unknown !== undefined) {
    options?.onUnknownEvent?.({
      ...(frame.id === undefined ? {} : { id: frame.id }),
      event: frame.event,
      type: unknown
    })
    return Option.none()
  }
  const data = yield* Schema.decodeUnknownEffect(ServerEventSchema)(payload)
  return Option.some(
    yield* validateServerEventFrame({
      ...(frame.id === undefined ? {} : { id: frame.id }),
      event: frame.event,
      data
    })
  )
})

/** Decode a complete SSE buffer using Effect's standards-compliant parser. */
export const decodeSseFramesEffect = Effect.fn("decodeSseFramesEffect")(function* (
  input: string,
  options?: SseDecodeOptions
) {
  const parsed: Array<Sse.EventEncoded> = []
  const retries: Array<Sse.Retry> = []
  const parser = Sse.makeParser((value) => {
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

  const frames: Array<Schema.Schema.Type<typeof Sse.EventEncoded>> = []
  for (const value of parsed) {
    frames.push(yield* Schema.decodeUnknownEffect(Sse.EventEncoded)(value))
  }
  return frames
})

export const decodeServerEventFramesEffect = Effect.fn("decodeServerEventFramesEffect")(function* (
  input: string,
  options?: SseDecodeOptions
) {
  const frames = yield* decodeSseFramesEffect(input, options)
  const decoded: Array<{
    readonly id?: string
    readonly event: string
    readonly data: ServerEvent
  }> = []
  for (const frame of frames) {
    const event = yield* decodeServerEventFrame(frame, options)
    if (Option.isSome(event)) decoded.push(event.value)
  }
  return decoded
})

export const encodeServerEventFrameEffect = Effect.fn("encodeServerEventFrameEffect")(function* (
  eventValue: ServerEvent,
  options?: EncodeServerEventOptions
) {
  const id = options?.id
  if (id?.includes("\0") || id?.includes("\r") || id?.includes("\n")) {
    return yield* Effect.fail(new InvalidSseId({ id }))
  }
  const eventData = yield* Schema.decodeUnknownEffect(ServerEventSchema)(eventValue)
  const data = JSON.stringify(eventData)
  return Sse.encoder.write({
    _tag: "Event",
    id,
    event: eventData.type,
    data
  })
})

/** A live SSE source as its frames (`id`, `event`, `data`), lazily, with cancellation owned by the stream. */
export const decodeSseFrameStreamEffect = (
  input: AsyncIterable<string | Uint8Array>,
  options?: SseDecodeOptions
) => {
  const encoder = new TextEncoder()
  const bytes = Stream.concat(
    Stream.fromAsyncIterable(input, (cause) => new StreamInputError({ cause })).pipe(
      Stream.map((chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk))
    ),
    Stream.succeed(encoder.encode("\n\n"))
  )
  const text = bytes.pipe(Stream.pipeThroughChannel(Channel.decodeText()))
  return Stream.suspend(() => {
    const pending: Array<Sse.AnyEvent> = []
    const parser = Sse.makeParser((value) => pending.push(value), parserOptions(options))
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
        return Stream.fromEffect(Schema.decodeUnknownEffect(Sse.EventEncoded)(value))
      })
    )
  })
}

/** Decode a live SSE source lazily, with cancellation owned by the stream. */
export const decodeServerEventStreamEffect = (
  input: AsyncIterable<string | Uint8Array>,
  options?: SseDecodeOptions
) =>
  decodeSseFrameStreamEffect(input, options).pipe(
    Stream.flatMap((frame) =>
      Stream.fromEffect(decodeServerEventFrame(frame, options)).pipe(
        Stream.flatMap((event) =>
          Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty
        )
      )
    )
  )
