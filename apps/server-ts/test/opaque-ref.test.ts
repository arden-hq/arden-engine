import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { decodeOpaque, encodeOpaque } from "../src/lib/opaque-ref.js"

const PageSchema = Schema.Struct({ version: Schema.Literal(1), offset: Schema.Int })

describe("opaque references", () => {
  it("round-trips a value the schema accepts", () => {
    const text = encodeOpaque({ version: 1, offset: 20 })
    expect(decodeOpaque(PageSchema, text)).toEqual(Option.some({ version: 1, offset: 20 }))
  })

  it("refuses a reference the model changed, even where base64url would shrug it off", () => {
    const text = encodeOpaque({ version: 1, offset: 20 })
    expect(Option.isNone(decodeOpaque(PageSchema, `${text}!!`))).toBe(true)
    expect(Option.isNone(decodeOpaque(PageSchema, `${text.slice(0, 4)}*${text.slice(4)}`))).toBe(
      true
    )
    expect(Option.isNone(decodeOpaque(PageSchema, encodeOpaque({ version: 2, offset: 20 })))).toBe(
      true
    )
    expect(Option.isNone(decodeOpaque(PageSchema, "not a reference"))).toBe(true)
  })
})
