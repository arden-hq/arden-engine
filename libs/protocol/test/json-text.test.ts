import { describe, expect, it } from "vitest"

import { parseJsonBody, parseJsonText, parseJsonTextOrUndefined } from "../src/common/index.js"

describe("json text", () => {
  it("reads any JSON value, null included", () => {
    expect(parseJsonText('{"a":[1,"b"]}')).toEqual({ a: [1, "b"] })
    expect(parseJsonText("null")).toBeNull()
    expect(parseJsonTextOrUndefined('"x"')).toBe("x")
  })

  it("throws one protocol error for text that is not JSON", () => {
    expect(() => parseJsonText("{")).toThrow("The text is not JSON")
  })

  it("answers undefined for text that is not JSON", () => {
    expect(parseJsonTextOrUndefined("")).toBeUndefined()
    expect(parseJsonTextOrUndefined("nope")).toBeUndefined()
  })

  it("reads a response body", async () => {
    expect(await parseJsonBody(new Response('{"ok":true}'))).toEqual({ ok: true })
    await expect(parseJsonBody(new Response("<html>"))).rejects.toThrow("The text is not JSON")
  })
})
