import { describe, expect, it } from "vitest"

import { errorMessage, redactedFailureText, toError } from "../src/errors.js"

describe("errorMessage", () => {
  it("reads an Error's message, else the fallback, else the value as text", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom")
    expect(errorMessage("plain", "fallback")).toBe("fallback")
    expect(errorMessage(42)).toBe("42")
  })

  it("wraps a thrown non-Error once and passes an Error through", () => {
    const original = new Error("kept")
    expect(toError(original)).toBe(original)
    expect(toError("text").cause).toBe("text")
  })
})

describe("redactedFailureText", () => {
  it("keeps credentials out of a stored failure", () => {
    const text = redactedFailureText(
      "GET https://user:hunter2@host/x failed\nAuthorization: Bearer abc.def api_key=sk-123 token: 'tok'"
    )
    expect(text).not.toMatch(/hunter2|abc\.def|sk-123|tok'/)
    expect(text).toContain("[redacted]")
    expect(text).not.toContain("\n")
  })

  it("cuts to the limit", () => {
    expect(redactedFailureText("x".repeat(5_000))).toHaveLength(2_000)
  })
})
