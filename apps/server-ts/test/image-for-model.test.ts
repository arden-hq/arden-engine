import type { ImageInput } from "@arden-hq/loop"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { ConversationArtifacts } from "../src/artifacts/conversation.js"
import { OPENAI_IMAGE_INPUT, patchCount } from "../src/lib/prompt-image.js"
import { encodePng, pngSize } from "../src/lib/png.js"
import { preserveBrowserScreenshot } from "../src/tools/browser-screenshot.js"
import { imageForModel } from "../src/tools/read-binary.js"

const wide = encodePng({
  width: 3000,
  height: 40,
  pixels: new Uint8Array(3000 * 40 * 4).fill(200)
})

const square = encodePng({
  width: 2000,
  height: 2000,
  pixels: new Uint8Array(2000 * 2000 * 4).fill(200)
})
const withinPatches = (size: { width: number; height: number } | undefined) =>
  size !== undefined &&
  size.width === size.height &&
  size.width < 2000 &&
  patchCount(size, OPENAI_IMAGE_INPUT.patchSize) <= OPENAI_IMAGE_INPUT.fitPatches

describe("an image read for the model", () => {
  it("is shrunk to the limits a route states, and sent at its stored size where it states none", async () => {
    const read = (limits: typeof OPENAI_IMAGE_INPUT | undefined, bytes = wide) =>
      imageForModel({
        file: "/nonexistent/wide.png",
        bytes,
        format: "png",
        limits,
        signal: new AbortController().signal
      }).then(
        (image) =>
          image && {
            mediaType: image.mediaType,
            source: image.source,
            size: image.size
          }
      )
    expect(await read(OPENAI_IMAGE_INPUT)).toEqual({
      mediaType: "image/png",
      source: { width: 3000, height: 40 },
      size: { width: 2048, height: 27 }
    })
    expect(withinPatches((await read(OPENAI_IMAGE_INPUT, square))?.size)).toBe(true)
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
      let calls = 0
      const shot = (imageInput: ImageInput | undefined, bytes = wide) =>
        preserveBrowserScreenshot({
          output: {
            result: "Captured the tab.",
            preview: "Screenshot",
            data: {
              url: "https://example.com/",
              captured_at: "2026-11-16T00:00:00.000Z"
            },
            modelContent: [
              {
                type: "image",
                media_type: "image/png",
                data: bytes.toString("base64")
              }
            ]
          },
          artifacts,
          sessionId: "s1",
          runId: "r1",
          toolCallId: `c${(calls += 1)}`,
          signal: new AbortController().signal,
          imageInput
        }).then((output) =>
          output.model_content?.flatMap((block) =>
            block.type === "image" ? [pngSize(Buffer.from(block.data, "base64"))] : []
          )
        )
      expect(await shot({ limits: OPENAI_IMAGE_INPUT })).toEqual([{ width: 2048, height: 27 }])
      const [squareSize] = (await shot({ limits: OPENAI_IMAGE_INPUT }, square)) ?? []
      expect(withinPatches(squareSize)).toBe(true)
      expect(await shot({ limits: undefined })).toEqual([{ width: 3000, height: 40 }])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
