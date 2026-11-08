import { describe, expect, it } from "vitest"

import { allDayFireAt, wallDayOf, wallInstant } from "../src/google/zoned-time.js"

describe("zoned wall-clock time", () => {
  it("places 08:00 on a day by the zone's offset on that day", () => {
    expect(allDayFireAt("2026-10-14", "America/New_York")).toBe(Date.parse("2026-10-14T12:00:00Z"))
    expect(allDayFireAt("2026-11-02", "America/New_York")).toBe(Date.parse("2026-11-02T13:00:00Z"))
    expect(allDayFireAt("2026-10-14", "Asia/Tokyo")).toBe(Date.parse("2026-10-13T23:00:00Z"))
  })

  it("refuses a date that is not a day", () => {
    expect(allDayFireAt("2026-02-30", "UTC")).toBeUndefined()
    expect(allDayFireAt("tomorrow", "UTC")).toBeUndefined()
  })

  it("resolves a daylight-saving gap to the later reading", () => {
    expect(wallInstant({ year: 2026, month: 3, day: 8 }, 150, "America/New_York")).toBe(
      Date.parse("2026-03-08T07:30:00Z")
    )
  })

  it("reads the wall day of an instant, not the UTC day", () => {
    expect(wallDayOf(Date.parse("2026-10-14T02:00:00Z"), "America/Los_Angeles")).toEqual({
      year: 2026,
      month: 10,
      day: 13,
      weekday: 2
    })
  })
})
