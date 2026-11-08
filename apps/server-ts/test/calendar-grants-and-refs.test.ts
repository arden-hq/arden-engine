import { googleAccountHasGrant, type GoogleAccount } from "@arden-hq/protocol/google"
import { describe, expect, it } from "vitest"
import { Effect } from "effect"

import { calendarWriteAccess } from "../src/tools/google-calendar-access.js"
import { calendarEventRef, parseCalendarEventRef } from "../src/tools/google-calendar-rules.js"
import { googleGrantAccess } from "../src/tools/google-grant-card.js"

const EVENTS = "https://www.googleapis.com/auth/calendar.events"
const account = (
  scopes: ReadonlyArray<string>,
  status: "ready" | "needs_auth" = "ready"
): GoogleAccount => ({
  id: "acct-1",
  email: "me@example.com",
  authorizations: [{ service: "calendar", scopes, status }]
})

describe("calendar grants", () => {
  it("are not held by the events scope alone", () => {
    expect(googleAccountHasGrant(account([EVENTS]), "calendar_list")).toBe(false)
    expect(googleAccountHasGrant(account([EVENTS]), "calendar_freebusy")).toBe(false)
  })

  it("are held by their own scope or a wider calendar scope", () => {
    const base = "https://www.googleapis.com/auth/"
    expect(
      googleAccountHasGrant(
        account([EVENTS, `${base}calendar.calendarlist.readonly`]),
        "calendar_list"
      )
    ).toBe(true)
    expect(
      googleAccountHasGrant(account([EVENTS, `${base}calendar.readonly`]), "calendar_list")
    ).toBe(true)
    expect(googleAccountHasGrant(account([EVENTS, `${base}calendar`]), "calendar_freebusy")).toBe(
      true
    )
    expect(
      googleAccountHasGrant(account([EVENTS, `${base}calendar.freebusy`]), "calendar_freebusy")
    ).toBe(true)
    expect(
      googleAccountHasGrant(account([`${base}calendar.calendarlist`]), "calendar_freebusy")
    ).toBe(false)
  })

  it("report missing only for a ready authorization, and unknown without one account", () => {
    const accounts = [account([EVENTS])]
    expect(googleGrantAccess(accounts, undefined, "calendar", "calendar_list").kind).toBe("missing")
    expect(googleGrantAccess(accounts, "ME@example.com", "calendar", "calendar_list").kind).toBe(
      "missing"
    )
    expect(
      googleGrantAccess([account([EVENTS], "needs_auth")], undefined, "calendar", "calendar_list")
        .kind
    ).toBe("allowed")
    expect(googleGrantAccess(accounts, "other@example.com", "calendar", "calendar_list").kind).toBe(
      "unknown"
    )
    expect(
      googleGrantAccess(
        [...accounts, { ...account([EVENTS]), id: "acct-2", email: "b@example.com" }],
        undefined,
        "calendar",
        "calendar_list"
      ).kind
    ).toBe("unknown")
  })
})

describe("calendar event references", () => {
  it("keep the old form for the primary calendar", () => {
    expect(calendarEventRef("me@example.com", "primary", "abc123")).toBe("me@example.com:abc123")
    expect(parseCalendarEventRef("me@example.com:abc123")).toEqual({
      account: "me@example.com",
      calendarId: "primary",
      id: "abc123"
    })
  })

  it("carry another calendar's id and read it back", () => {
    for (const calendarId of [
      "team@group.calendar.google.com",
      "en.usa#holiday@group.v.calendar.google.com",
      "odd:id@x.com"
    ]) {
      const ref = calendarEventRef("me@example.com", calendarId, "evt_20261012T090000Z")
      expect(parseCalendarEventRef(ref)).toEqual({
        account: "me@example.com",
        calendarId,
        id: "evt_20261012T090000Z"
      })
    }
  })

  it("lets calendar_id qualify an old reference and rejects conflicts with a qualified one", () => {
    expect(parseCalendarEventRef("me@example.com:abc123", "team@group")).toEqual({
      account: "me@example.com",
      calendarId: "team@group",
      id: "abc123"
    })
    expect(
      parseCalendarEventRef("me@example.com:team%40group:abc123", "other@group")
    ).toBeUndefined()
  })

  it("refuse anything that is not a reference", () => {
    expect(parseCalendarEventRef("abc123")).toBeUndefined()
    expect(parseCalendarEventRef("not-an-account:abc")).toBeUndefined()
    expect(parseCalendarEventRef("me@example.com:")).toBeUndefined()
    expect(parseCalendarEventRef("me@example.com::abc")).toBeUndefined()
    expect(parseCalendarEventRef("a@b.c:d:e:f")).toBeUndefined()
  })
})

describe("calendar write access", () => {
  it.each(["reader", "freeBusyReader", "unknown"])(
    "refuses writes for role %s",
    async (accessRole) => {
      const connected = account([
        EVENTS,
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
      ])
      await expect(
        calendarWriteAccess({
          google: {
            accounts: () => [connected],
            request: () =>
              Effect.succeed({ account: connected, value: { id: "team@group", accessRole } })
          },
          accountRef: connected.id,
          calendarId: "team@group",
          signal: new AbortController().signal
        })
      ).rejects.toThrow("read-only")
    }
  )
})
