import { expect, it } from "vitest"

import { objectRootProblems } from "../src/tools/tool-contract.js"

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
