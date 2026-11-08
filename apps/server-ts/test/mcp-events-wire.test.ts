import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  decodeEventsPage,
  decodePollResult,
  decodeStreamSignal,
  subscriptionIdOf
} from "../src/mcp/events/wire.js"

describe("MCP Events wire", () => {
  it("lists only the events Arden can receive, skipping definitions it cannot read", () => {
    const page = decodeEventsPage({
      events: [
        { name: "issue.created", description: "A new issue", delivery: ["push", "poll"] },
        { name: "hook.only", description: "", delivery: ["webhook"] },
        { name: "", delivery: ["poll"] },
        "not an event",
        {
          name: "message.posted",
          delivery: ["poll", "carrier-pigeon"],
          inputSchema: { type: "object", properties: { channel: { type: "string" } } }
        }
      ],
      nextCursor: "page-2"
    })

    expect(page).toEqual({
      events: [
        {
          name: "issue.created",
          description: "A new issue",
          delivery: ["push", "poll"],
          inputSchema: { type: "object" }
        },
        {
          name: "message.posted",
          description: "",
          delivery: ["poll"],
          inputSchema: { type: "object", properties: { channel: { type: "string" } } }
        }
      ],
      nextCursor: "page-2"
    })
  })

  it.each([
    ["absent", {}],
    ["null", { cursor: null }]
  ])("reads an %s poll cursor as no position", (_case, cursor) => {
    expect(decodePollResult({ events: [], ...cursor })).toEqual({
      events: [],
      cursor: undefined,
      truncated: false,
      hasMore: false,
      nextPollMs: undefined
    })
  })

  it("routes a notification by the subscription id in its _meta", () => {
    expect(
      subscriptionIdOf({ _meta: { "io.modelcontextprotocol/subscriptionId": "arden-events-3" } })
    ).toBe("arden-events-3")
    expect(subscriptionIdOf({ _meta: {} })).toBeUndefined()
  })

  it("decodes an event notification with the cursor after it", () => {
    expect(
      decodeStreamSignal("notifications/events/event", {
        eventId: "e-1",
        name: "issue.created",
        timestamp: "2026-10-14T09:00:00Z",
        data: { title: "Broken login" },
        cursor: "c-1"
      })
    ).toEqual({
      kind: "event",
      occurrence: {
        eventId: "e-1",
        name: "issue.created",
        timestamp: "2026-10-14T09:00:00Z",
        data: { title: "Broken login" }
      },
      cursor: "c-1"
    })
  })

  it("never throws on anything a server sends", () => {
    const methods = [
      "notifications/events/active",
      "notifications/events/event",
      "notifications/events/heartbeat",
      "notifications/events/error",
      "notifications/events/terminated",
      "notifications/other"
    ]
    fc.assert(
      fc.property(fc.jsonValue(), fc.constantFrom(...methods), (value, method) => {
        decodeEventsPage(value)
        decodePollResult(value)
        decodeStreamSignal(method, value)
        subscriptionIdOf(value)
      }),
      { numRuns: 200 }
    )
  })
})
