import { describe, expect, it } from "vitest"
import {
  createTool,
  createToolset,
  ToolExecutionError,
  type StandardSchemaV1
} from "../src/index.js"

const SECRET = "tdk_Real1234567890abcdefXYZ"

const anyArgs: StandardSchemaV1<unknown, { readonly fail?: boolean }> = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value: value ?? {} }) }
}

const leaky = createTool({
  name: "leaky",
  description: "Returns a secret it found",
  parameters: anyArgs,
  metadata: {},
  execute: async (input) => {
    if (input.fail === true) throw new ToolExecutionError(`failed near ${SECRET}`, { preview: "x" })
    return {
      result: `found ${SECRET}`,
      preview: `preview ${SECRET}`,
      model_content: [{ type: "text", text: `block ${SECRET}` }]
    }
  }
})

const scrub = async (text: string) => text.split(SECRET).join("[saved secret]")

describe("the toolset's scrub", () => {
  it("runs over a result's content, preview and text blocks, and a failure's message", async () => {
    const toolset = createToolset([leaky], { toJsonSchema: () => ({ type: "object" }), scrub })(
      undefined
    )
    const result = await toolset.execute({ name: "leaky", args: {}, toolCallId: "1" })
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(result.content).toBe("found [saved secret]")
    await expect(
      toolset.execute({ name: "leaky", args: { fail: true }, toolCallId: "2" })
    ).rejects.toMatchObject({ message: "failed near [saved secret]", preview: "x" })
  })
})
