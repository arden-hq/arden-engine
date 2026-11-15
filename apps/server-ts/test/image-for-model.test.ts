import { describe, expect, it } from "vitest"

import { OPENAI_IMAGE_INPUT } from "../src/lib/prompt-image.js"
import { encodePng } from "../src/lib/png.js"
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
