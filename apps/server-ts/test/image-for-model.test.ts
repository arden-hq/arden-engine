import type { ImageInput } from "@arden-hq/loop"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { ConversationArtifacts } from "../src/artifacts/conversation.js"
import { OPENAI_IMAGE_INPUT } from "../src/lib/prompt-image.js"
import { encodePng, pngSize } from "../src/lib/png.js"
import { preserveBrowserScreenshot } from "../src/tools/browser-screenshot.js"
import { imageForModel } from "../src/tools/read-binary.js"

/** A 3000x40 PNG: over OpenAI's 2048 px longest side. */
const wide = encodePng({ width: 3000, height: 40, pixels: new Uint8Array(3000 * 40 * 4).fill(200) })

describe("an image read for the model", () => {
  it("is shrunk to the limits a route states, and sent at its stored size where it states none", async () => {
    const read = (limits: typeof OPENAI_IMAGE_INPUT | undefined) =>
      imageForModel({
        file: "/nonexistent/wide.png",
        bytes: wide,
        format: "png",
        limits,
        signal: new AbortController().signal
      }).then(
        (image) => image && { mediaType: image.mediaType, source: image.source, size: image.size }
      )
    expect(await read(OPENAI_IMAGE_INPUT)).toEqual({
      mediaType: "image/png",
      source: { width: 3000, height: 40 },
      size: { width: 2048, height: 27 }
    })
    expect(await read(undefined)).toEqual({
      mediaType: "image/png",
      source: { width: 3000, height: 40 },
      size: { width: 3000, height: 40 }
    })
  })
})

describe("a browser screenshot for the model", () => {
  it("is fitted to the route's stated limits, and sent as captured where it states none", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-screenshot-"))
    try {
      const artifacts = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* ConversationArtifacts
        }).pipe(Effect.provide(ConversationArtifacts.layer(join(directory, "conversations"))))
      )
      const shot = (imageInput: ImageInput | undefined) =>
        preserveBrowserScreenshot({
          output: {
            result: "Captured the tab.",
            preview: "Screenshot",
            data: { url: "https://example.com/", captured_at: "2026-11-16T00:00:00.000Z" },
            modelContent: [
              { type: "image", media_type: "image/png", data: wide.toString("base64") }
            ]
          },
          artifacts,
          sessionId: "s1",
          runId: "r1",
          toolCallId: "c1",
          signal: new AbortController().signal,
          imageInput
        }).then((output) =>
          output.model_content?.flatMap((block) =>
            block.type === "image" ? [pngSize(Buffer.from(block.data, "base64"))] : []
          )
        )
      expect(await shot({ limits: OPENAI_IMAGE_INPUT })).toEqual([{ width: 2048, height: 27 }])
      expect(await shot({ limits: undefined })).toEqual([{ width: 3000, height: 40 }])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
