import { describe, expect, it } from "vitest"
import { readToolResult, TOOL_RESULT_MAX_BYTES } from "../src/tool-result.js"

const result = JSON.stringify({
  items: [{ name: "Tent", price: 120, tags: ["a", "b"] }],
  total: 0,
  note: null
})

describe("reading a value from a tool result", () => {
  it.each([
    ["", JSON.parse(result)],
    ["items[0].tags.1", "b"],
    ["total", 0],
    ["note", null]
  ])("reads %j", (path, value) => {
    expect(readToolResult(result, path)).toEqual({ status: "value", value })
  })

  it.each([["items.1"], ["items.0.price.cents"], ["missing"], ["toString"], ["items.length"]])(
    "finds nothing at %j",
    (path) => {
      expect(readToolResult(result, path)).toEqual({ status: "unavailable", reason: "no_path" })
    }
  )

  it("refuses a text result", () => {
    expect(readToolResult("Found 3 tents.", "")).toEqual({
      status: "unavailable",
      reason: "not_json"
    })
  })

  it("refuses a value over the cap but reads a small part of the same result", () => {
    const big = JSON.stringify({ rows: ["x".repeat(TOOL_RESULT_MAX_BYTES)], count: 1 })
    expect(readToolResult(big, "rows")).toEqual({ status: "unavailable", reason: "too_large" })
    expect(readToolResult(big, "count")).toEqual({ status: "value", value: 1 })
  })
})
