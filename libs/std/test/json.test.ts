import { describe, expect, it } from "vitest"

import { canonicalJson, compareCodePoints, engineOrderedJson, sameJson } from "../src/json.js"

describe("canonicalJson", () => {
  it("sorts keys at every depth, leaves array order alone and writes compact JSON", () => {
    const value = { z: [{ b: 2, a: "x" }, null], a: true, m: { y: 1.5, x: -0 } }
    const expected = '{"a":true,"m":{"x":0,"y":1.5},"z":[{"a":"x","b":2},null]}'
    expect(canonicalJson(value)).toBe(expected)
    expect(canonicalJson(value, { lenient: true })).toBe(expected)
  })

  it("orders keys by code point, so an astral character sorts after a high BMP one", () => {
    const value = { "\u{1F600}": 1, "～": 2 }
    expect(canonicalJson(value)).toBe('{"～":2,"\u{1F600}":1}')
    expect(compareCodePoints("～", "\u{1F600}")).toBe(-1)
  })

  it("refuses in strict mode what JSON cannot say", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError)
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError)
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError)
    expect(() => canonicalJson([() => 1])).toThrow(TypeError)
  })

  it("writes what JSON.stringify writes in lenient mode", () => {
    const value = {
      b: undefined,
      a: [undefined, Number.NaN, new Date(0)],
      c: { toJSON: () => "j" }
    }
    expect(canonicalJson(value, { lenient: true })).toBe(
      '{"a":[null,null,"1970-01-01T00:00:00.000Z"],"c":"j"}'
    )
    expect(() => canonicalJson(undefined, { lenient: true })).toThrow(TypeError)
  })
})

describe("engineOrderedJson", () => {
  const first = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "object" && item !== null && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, (item as Record<string, unknown>)[key]])
          )
        : item
    )

  it("writes the first implementation's bytes, integer-like keys included", () => {
    const value = {
      "2": 1,
      "10": 2,
      "-x": 3,
      $ref: 4,
      "1a": 5,
      nested: { b: [{ "9": 1, "10": 2 }], a: 1 }
    }
    expect(engineOrderedJson(value)).toBe(first(value))
    expect(engineOrderedJson({ "2": 1, "10": 2 })).toBe('{"2":1,"10":2}')
    expect(canonicalJson({ "2": 1, "10": 2 }, { lenient: true })).toBe('{"10":2,"2":1}')
  })
})

describe("sameJson", () => {
  it("ignores key order, not content", () => {
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(sameJson({ a: undefined }, {})).toBe(false)
    expect(sameJson([1, 2], [2, 1])).toBe(false)
    expect(sameJson(undefined, "undefined")).toBe(false)
  })
})
