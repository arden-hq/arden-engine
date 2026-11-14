import { describe, expect, it } from "vitest"

import { hashInputPaths } from "../src/tools/tool-contract.js"

const text = (description: string) => ({ type: "string", description })

describe("hashInputPaths", () => {
  it("finds a hash input by its name", () => {
    const parameters = { type: "object", properties: { revision: text("Which change to read.") } }
    expect(hashInputPaths("read_change", parameters)).toEqual(["read_change.revision"])
  })

  it("finds a hash input by its description", () => {
    const parameters = {
      type: "object",
      properties: { expected: text("The sha256 of the file as last read.") }
    }
    expect(hashInputPaths("update", parameters)).toEqual(["update.expected"])
  })

  it("looks inside lists, choices and shared definitions", () => {
    const parameters = {
      type: "object",
      properties: {
        sources: { type: "array", items: { anyOf: [{ $ref: "#/$defs/Source" }] } }
      },
      $defs: {
        Source: { type: "object", properties: { revision: text("The exact turn read.") } }
      }
    }
    expect(hashInputPaths("propose", parameters)).toEqual(["propose.sources.revision"])
  })

  it("lets a counter and a fixed choice pass", () => {
    const parameters = {
      type: "object",
      properties: {
        expected_revision: { type: "integer", description: "The offer's revision number." },
        snapshot: { anyOf: [{ type: "string", enum: ["none"] }, { type: "object" }] },
        page: text("The page's link, such as arden:memory/projects/arden.")
      }
    }
    expect(hashInputPaths("act", parameters)).toEqual([])
  })
})
