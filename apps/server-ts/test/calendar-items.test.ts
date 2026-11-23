import type { GoogleAccount } from "@arden-hq/protocol/google"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { connectionItemEvent } from "../src/automations/producers/connection-item.js"
import { fetchCalendar } from "../src/connections/items/calendar.js"

const account: GoogleAccount = {
  id: "acct-1",
  email: "me@example.com",
  authorizations: [{ service: "calendar", scopes: [], status: "ready" }]
}

const google = (items: ReadonlyArray<unknown>) => ({
  request: () => Effect.succeed({ account, value: { items, nextSyncToken: "token-2" } })
})

const fetch = (items: ReadonlyArray<unknown>, cursor: string | undefined) =>
  Effect.runPromise(
    fetchCalendar({ google: google(items), account, calendarId: "primary", cursor })
  )

const moved = {
  id: "event-1",
  summary: "Planning",
  start: { dateTime: "2999-01-02T10:00:00Z" },
  end: { dateTime: "2999-01-02T11:00:00Z" },
  organizer: { email: "lead@example.com" },
  created: "2026-01-01T00:00:00Z",
  updated: "2026-01-05T00:00:00Z"
}

describe("calendar changes as items", () => {
  it("takes a baseline on the first fetch and stores nothing", async () => {
    const first = await fetch([moved], undefined)
    expect(first.items).toEqual([])
    expect(JSON.parse(first.cursor).sync_token).toBe("token-2")
  })

  it("stores one item per change, and the item publishes calendar.changed", async () => {
    const cursor = (await fetch([moved], undefined)).cursor
    const { items } = await fetch([moved], cursor)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      source: "calendar",
      account: "acct-1",
      externalId: "event-1:2026-01-05T00:00:00Z",
      threadKey: "event-1",
      title: "Planning",
      sender: "lead@example.com",
      detail: { change: "changed", event_id: "event-1", start: "2999-01-02T10:00:00Z" }
    })
    const events = items.map((item) =>
      connectionItemEvent({
        itemId: "item_1",
        source: item.source,
        threadKey: item.threadKey,
        title: item.title,
        sender: item.sender,
        receivedAt: item.receivedAt,
        snippet: item.snippet,
        detail: item.detail
      })
    )
    expect(events[0]).toMatchObject({
      eventType: "calendar.changed",
      eventKey: "item_1",
      context: { event: { change: "changed", summary: "Planning" } }
    })
  })
})
