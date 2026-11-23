import { expect, it } from "vitest"

import { objectRootProblems } from "../src/tools/tool-contract.js"

/**
 * OpenAI refuses a function whose parameters are not `type: "object"` at the
 * root, and OpenRouter passes the refusal on for every request of the chat:
 * "Invalid schema for function 'permissions_read': schema must be a JSON
 * Schema of 'type: "object"', got 'type: "None"'." (live, 2026-11-16). That
 * root was `Schema.Struct({})`'s JSON Schema.
 */
it("refuses a tool whose parameters a model receives without an object root", () => {
  const refused = [
    { anyOf: [{ type: "object" }, { type: "array" }], properties: {} },
    { type: "array", items: { type: "string" } },
    { type: "string" }
  ]
  for (const root of refused) {
    const problems = objectRootProblems("permissions_read", root)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("permissions_read")
  }
  expect(
    objectRootProblems("usage_report", {
      type: "object",
      properties: {},
      additionalProperties: false
    })
  ).toEqual([])
})
