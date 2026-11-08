import { Schema } from "effect"
import { expect, it } from "vitest"
import * as OpenAiStructuredOutput from "effect/unstable/ai/OpenAiStructuredOutput"
import { recordOf } from "./kit.js"

it("compiles a constrained Effect schema into the dialect strict output accepts", () => {
  const { jsonSchema } = OpenAiStructuredOutput.toCodecOpenAI(
    Schema.Struct({
      outcome: Schema.Literals(["no_change", "updates"] as const),
      note: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
      tags: Schema.Array(Schema.String).check(Schema.isMaxLength(64)),
      maybe: Schema.optionalKey(Schema.String)
    })
  )

  const wire = JSON.stringify(jsonSchema)
  for (const forbidden of ["allOf", "not", "dependentRequired", "if", "then", "else", "oneOf"]) {
    expect(wire).not.toContain(`"${forbidden}"`)
  }
  expect(wire).not.toContain("minLength")
  expect(wire).not.toContain("maxLength")

  const schema = recordOf(jsonSchema)
  expect(schema.additionalProperties).toBe(false)
  expect(schema.required).toEqual(["outcome", "note", "tags", "maybe"])
  const properties = recordOf(schema["properties"])
  expect(recordOf(properties["maybe"])["anyOf"]).toEqual([{ type: "string" }, { type: "null" }])
  expect(String(recordOf(properties["note"])["description"])).toContain("at most 200")
  expect(recordOf(properties["tags"])["maxItems"]).toBe(64)
})
