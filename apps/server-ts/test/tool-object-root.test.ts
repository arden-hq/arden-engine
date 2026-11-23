import { expect, it } from "vitest"

import { objectRootProblems } from "../src/tools/tool-contract.js"

it("refuses a tool whose parameters a model receives without an object root", () => {
  const refused = [
    { anyOf: [{ type: "object" }, { type: "array" }], properties: {} },
    { type: "array", items: { type: "string" } },
    { type: "string" }
  ]
  for (const root of refused) {
    expect(objectRootProblems("permissions_read", root)).not.toEqual([])
  }
  expect(
    objectRootProblems("usage_report", {
      type: "object",
      properties: {},
      additionalProperties: false
    })
  ).toEqual([])
})
