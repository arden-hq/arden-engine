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
  expect(
    objectRootProblems("permissions_read", {
      anyOf: [{ type: "object" }, { type: "array" }],
      properties: { _display_title: { type: "string" } }
    })
  ).toEqual([
    'permissions_read parameters must be type "object" at the root; an empty input is EmptyParametersSchema'
  ])
  expect(
    objectRootProblems("usage_report", {
      type: "object",
      properties: {},
      additionalProperties: false
    })
  ).toEqual([])
})
