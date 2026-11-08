import { Schema } from "effect"
import fc from "fast-check"
import { expect, it } from "vitest"

import {
  ProtocolError,
  isKnownServerEventType,
  decodeServerEvent,
  decodeServerEventStream,
  decodeServerEventStreamBuffer,
  decodeSseFrames,
  encodeServerEventFrame
} from "@arden-hq/protocol"
import { reasoningStreamEventSchemas, textStreamEventSchemas } from "@arden-hq/protocol/effect/chat"
import { AppDestinationSchema } from "@arden-hq/protocol/effect/common"
import { collect } from "./kit.js"

const resumeHistory = {
  messages: [],
  active_work_tail: null,
  runtime: {
    session_id: "session-1",
    latest_event_seq: 1,
    checkpoint_seq: 0,
    active_run: null,
    blocking_work: false,
    pending_approvals: [],
    pending_connections: []
  },
  page: {
    has_more_before: false,
    has_more_after: false,
    before: null,
    after: null
  },
  context_budget: {
    model: "test",
    hard_limit: 100,
    compaction_trigger: 80,
    input_tokens: 0,
    message_count: 0
  }
}

it("round-trips and streams SSE safely", async () => {
  const event = {
    type: "TEXT_MESSAGE_CONTENT" as const,
    timestamp: 1,
    seq: 7,
    session_id: "session-1",
    message_id: "message-1",
    delta: "hé"
  }
  const frame = encodeServerEventFrame(event, { id: "7" })

  const bufferedRetries: Array<number> = []
  expect(
    decodeSseFrames(`retry: 1500\n\n${frame}`, {
      onRetry: ({ retryAfterMs }) => bufferedRetries.push(retryAfterMs)
    })[0]?.id
  ).toBe("7")
  expect(bufferedRetries).toEqual([1500])
  expect(decodeServerEventStreamBuffer(frame)).toEqual([
    { id: "7", event: "TEXT_MESSAGE_CONTENT", data: event }
  ])
  expect(() => encodeServerEventFrame(event, { id: "7\nevent: injected" })).toThrow(ProtocolError)
  expect(() => encodeServerEventFrame(event, { id: "7\0ignored" })).toThrow(ProtocolError)

  const bytes = new TextEncoder().encode(frame)
  const utf8Start = bytes.indexOf(0xc3)
  let closed = false
  const source = (async function* () {
    try {
      yield bytes.slice(0, utf8Start + 1)
      yield bytes.slice(utf8Start + 1)
      yield new Uint8Array()
    } finally {
      closed = true
    }
  })()

  const iterator = decodeServerEventStream(source)[Symbol.asyncIterator]()
  const first = await iterator.next()
  expect(first.value.data).toMatchObject({ type: "TEXT_MESSAGE_CONTENT", delta: "hé" })
  await iterator.return?.()
  expect(closed).toBe(true)

  const liveRetries: Array<number> = []
  const retrySource = (async function* () {
    yield "retry: 2500\n\n"
  })()
  for await (const _ of decodeServerEventStream(retrySource, {
    onRetry: ({ retryAfterMs }) => liveRetries.push(retryAfterMs)
  })) {
  }
  expect(liveRetries).toEqual([2500])

  const unterminatedMultilineFrame =
    "id: 7\r\n" +
    "event: TEXT_MESSAGE_CONTENT\r\n" +
    'data: {"type":"TEXT_MESSAGE_CONTENT",\r\n' +
    'data: "timestamp":1,"session_id":"session-1",\r\n' +
    'data: "seq":7,"message_id":"message-1","delta":"hé"}\r\n'
  expect(decodeServerEventStreamBuffer(unterminatedMultilineFrame)).toEqual([
    { id: "7", event: "TEXT_MESSAGE_CONTENT", data: event }
  ])
  const unterminatedSource = (async function* () {
    yield unterminatedMultilineFrame.slice(0, 17)
    yield unterminatedMultilineFrame.slice(17)
  })()
  expect(await collect(decodeServerEventStream(unterminatedSource))).toEqual([
    { id: "7", event: "TEXT_MESSAGE_CONTENT", data: event }
  ])

  const malformed = (async function* () {
    yield "event: TEXT_MESSAGE_CONTENT\ndata: {broken}\n\n"
  })()
  await expect(collect(decodeServerEventStream(malformed))).rejects.toBeInstanceOf(ProtocolError)
  expect(() =>
    decodeServerEventStreamBuffer(
      'event: TEXT_MESSAGE_START\ndata: {"type":"TEXT_MESSAGE_CONTENT","message_id":"m","delta":"x"}\n\n'
    )
  ).toThrow(ProtocolError)
  expect(() =>
    decodeServerEventStreamBuffer(
      'id: 8\nevent: TEXT_MESSAGE_CONTENT\ndata: {"type":"TEXT_MESSAGE_CONTENT","seq":7,"message_id":"m","delta":"x"}\n\n'
    )
  ).toThrow(ProtocolError)
  expect(() =>
    decodeServerEventStreamBuffer(
      'event: stream_reset\ndata: {"type":"stream_reset","reason":"slow_consumer"}\n\n'
    )
  ).toThrow(ProtocolError)
  expect(() =>
    decodeServerEventStreamBuffer(
      'id: 7\nevent: stream_keepalive\ndata: {"type":"stream_keepalive","seq":7,"latest_seq":8}\n\n'
    )
  ).toThrow(ProtocolError)
})

it("skips an event type this build does not know and keeps the stream open", async () => {
  expect(isKnownServerEventType("RUN_STARTED")).toBe(true)
  expect(isKnownServerEventType("run_teleported")).toBe(false)

  expect(() =>
    decodeServerEventStreamBuffer('event: RUN_FINISHED\ndata: {"type":"RUN_FINISHED"}\n\n', {
      onUnknownEvent: () => {
        throw new Error("must not be called")
      }
    })
  ).toThrow(ProtocolError)

  const snapshot = decodeServerEvent({
    type: "stream_snapshot",
    session_id: "session-1",
    seq: 2,
    snapshot: {
      version: 1,
      applied_seq: 2,
      history: { ...resumeHistory, runtime: { ...resumeHistory.runtime, latest_event_seq: 2 } },
      active_events: [
        {
          type: "TEXT_MESSAGE_CONTENT",
          session_id: "session-1",
          seq: 1,
          replay: true,
          message_id: "message-1",
          delta: "partial"
        },
        { type: "run_teleported", session_id: "session-1", seq: 2, replay: true, run_id: "run-1" }
      ]
    }
  })
  if (snapshot.type !== "stream_snapshot") throw new Error("expected a snapshot")
  expect(snapshot.snapshot.active_events.map((event) => event.type)).toEqual([
    "TEXT_MESSAGE_CONTENT"
  ])
})

it("streams any mix of known and unknown events, split anywhere: known ones arrive in order, unknown ones are reported and skipped", async () => {
  const EventSchema = Schema.Union([...textStreamEventSchemas, ...reasoningStreamEventSchemas])
  const known = Schema.toArbitrary(EventSchema)(fc)
    .map((event): unknown => JSON.parse(JSON.stringify(event)))
    .filter(Schema.is(EventSchema))
    .map((event) => ({ known: true as const, event }))
  const unknown = fc
    .record({
      type: fc.stringMatching(/^[a-z_]{1,12}$/).filter((type) => !isKnownServerEventType(type)),
      id: fc.option(fc.nat({ max: 99 }).map(String), { nil: undefined }),
      payload: fc.dictionary(fc.string(), fc.jsonValue({ maxDepth: 1 }), { maxKeys: 3 })
    })
    .map((frame) => ({ known: false as const, ...frame }))
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.oneof(known, unknown), { maxLength: 6 }),
      fc.array(fc.nat(), { maxLength: 5 }),
      async (items, cuts) => {
        const text = items
          .map((item) =>
            item.known
              ? encodeServerEventFrame(
                  item.event,
                  item.event.seq === undefined ? {} : { id: String(item.event.seq) }
                )
              : `${item.id === undefined ? "" : `id: ${item.id}\n`}event: ${item.type}\ndata: ${JSON.stringify({ ...item.payload, type: item.type })}\n\n`
          )
          .join("")
        const bytes = new TextEncoder().encode(text)
        const points = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))].sort(
          (a, b) => a - b
        )
        const chunks = [0, ...points].map((start, index) =>
          bytes.slice(start, [...points, bytes.length][index])
        )
        const dropped: Array<unknown> = []
        const decoded = await collect(
          decodeServerEventStream(
            (async function* () {
              yield* chunks
            })(),
            { onUnknownEvent: (frame) => dropped.push(frame) }
          )
        )
        let lastId: string | undefined
        const expected: Array<unknown> = []
        const expectedDropped: Array<unknown> = []
        for (const item of items) {
          const id = item.known ? item.event.seq : item.id
          if (id !== undefined) lastId = String(id)
          const withId = lastId === undefined ? {} : { id: lastId }
          if (item.known) expected.push({ ...withId, event: item.event.type, data: item.event })
          else expectedDropped.push({ ...withId, event: item.type, type: item.type })
        }
        expect({ decoded, dropped }).toEqual({ decoded: expected, dropped: expectedDropped })
        expect(decodeServerEventStreamBuffer(text)).toEqual(decoded)
      }
    ),
    { numRuns: 50 }
  )
})

it("decodes a saved Task destination named work as a task, and writes task", () => {
  const navigation = (destination: unknown) => ({
    type: "navigation_requested",
    origin_session_id: "session-1",
    destination,
    label: "Open the Task"
  })
  expect(decodeServerEvent(navigation({ kind: "work", item_id: "item-1" }))).toEqual(
    navigation({ kind: "task", item_id: "item-1" })
  )
  expect(decodeServerEvent(navigation({ kind: "work" }))).toEqual(navigation({ kind: "home" }))
  expect(Schema.encodeSync(AppDestinationSchema)({ kind: "task", item_id: "item-1" })).toEqual({
    kind: "task",
    item_id: "item-1"
  })
})

it("round-trips the live input_taken event for a run", () => {
  const event = { type: "input_taken" as const, session_id: "session-1", seq: 12, run_id: "run-1" }
  expect(decodeServerEvent(event)).toEqual(event)
  expect(() => decodeServerEvent({ ...event, run_id: undefined })).toThrow()
})
