import { Schema } from "effect"
import fc from "fast-check"
import { expect, it } from "vitest"

import {
  ProtocolError,
  isKnownServerEventType,
  decodeServerEvent,
  decodeServerEventStream,
  decodeServerEventStreamBuffer,
  encodeServerEventFrame
} from "@arden-hq/protocol"
import { reasoningStreamEventSchemas, textStreamEventSchemas } from "@arden-hq/protocol/effect/chat"
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

it("rejects frame ids that could inject fields and headers that disagree with the data", () => {
  const event = {
    type: "TEXT_MESSAGE_CONTENT" as const,
    timestamp: 1,
    seq: 7,
    session_id: "session-1",
    message_id: "message-1",
    delta: "x"
  }
  expect(() => encodeServerEventFrame(event, { id: "7\nevent: injected" })).toThrow(ProtocolError)
  expect(() => encodeServerEventFrame(event, { id: "7\0ignored" })).toThrow(ProtocolError)
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
