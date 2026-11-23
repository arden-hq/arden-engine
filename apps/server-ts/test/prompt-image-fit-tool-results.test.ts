import { expect, it } from "vitest"
import type { ChatMessage } from "@arden-hq/loop"
import { fitPromptImages } from "../src/providers/prompt-image-fit.js"

const pngHeader = (width: number, height: number): string => {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write("IHDR", 12, "ascii")
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes.toString("base64")
}

const IMAGE = { type: "image", media_type: "image/png", data: pngHeader(5600, 5600) } as const
const LIMITS = { patchSize: 32, fitSide: 2048, fitPatches: 1600, maxPatches: 2500 }

it("fits an image a tool returned the same way as one in a message", async () => {
  const messages: ReadonlyArray<ChatMessage> = [
    { role: "user", content: [IMAGE] },
    { role: "tool", tool_call_id: "read", content: "Read photo.png", model_content: [IMAGE] }
  ]
  const result = await fitPromptImages({
    messages,
    limits: LIMITS,
    resize: async () => undefined
  })
  const parts = result.messages.flatMap((message) => {
    if (message.role === "user") return message.content
    if (message.role === "tool") return message.model_content ?? []
    return []
  })
  expect(parts).toHaveLength(2)
  for (const part of parts) {
    expect(part.type).toBe("text")
    expect(JSON.stringify(part)).toContain("5600x5600")
  }
})
