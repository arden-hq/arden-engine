import { describe, expect, it } from "vitest"

import { JsonTextError, parseJsonText } from "../src/json-text.js"

describe("parseJsonText", () => {
  it("returns the parsed value", () => {
    expect(parseJsonText('{"a":[1,null]}')).toEqual({ a: [1, null] })
  })

  it("throws a JsonTextError carrying the parse detail", () => {
    let thrown: unknown
    try {
      parseJsonText("{nope")
    } catch (cause) {
      thrown = cause
    }
    expect(thrown).toBeInstanceOf(JsonTextError)
    expect((thrown as JsonTextError).message).toBe(
      ((thrown as JsonTextError).cause as Error).message
    )
  })
})
