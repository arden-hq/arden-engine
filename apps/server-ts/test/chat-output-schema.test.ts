import { describe, expect, it } from "vitest"

import { chatOutputOptions, outputSchemaProblem } from "../src/models/structured-output.js"

const verdict = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    score: { type: "number" },
    note: { type: "string" }
  },
  required: ["verdict", "score"],
  additionalProperties: false
}

const validate = async (value: unknown) => {
  const result = await chatOutputOptions(verdict, "openai").schema["~standard"].validate(value)
  return result.issues === undefined ? { value: result.value } : { issues: result.issues.length }
}

describe("a caller's output schema for a Chat run", () => {
  it("accepts an answer that matches and refuses one that does not", async () => {
    expect(await validate({ verdict: "pass", score: 0.9 })).toEqual({
      value: { verdict: "pass", score: 0.9 }
    })
    expect(await validate({ verdict: "fail", score: 0, note: null })).toEqual({
      value: { verdict: "fail", score: 0 }
    })
    expect(await validate({ verdict: "maybe", score: 0.9 })).toMatchObject({ issues: 1 })
    expect(await validate({ score: 0.9 })).toMatchObject({ issues: 1 })
  })

  it("refuses a schema it would have to run caller regular expressions for", () => {
    expect(outputSchemaProblem({ type: "string", pattern: "^(a+)+$" }, "openai")).toMatch(
      /not supported/
    )
    expect(outputSchemaProblem(verdict, "openai")).toBeUndefined()
  })
})
