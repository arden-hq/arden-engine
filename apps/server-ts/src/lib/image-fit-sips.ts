import type { ImageInputLimits } from "@arden-hq/loop"
import { PLATFORM } from "@arden-hq/std/process"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { fitDimensions, type ImageSize } from "./prompt-image.js"

const SIPS_IMAGE_FORMAT = {
  png: "png",
  jpeg: "jpeg",
  gif: "gif",
  webp: "webp",
  heic: "heic"
} as const
export type SipsImageFormat = (typeof SIPS_IMAGE_FORMAT)[keyof typeof SIPS_IMAGE_FORMAT]

const SIPS_SOURCE = { file: "file", bytes: "bytes" } as const

export interface SipsFittedImage {
  readonly mediaType: "image/png" | "image/jpeg"
  readonly data: Buffer
  readonly source: ImageSize
  readonly size: ImageSize
}

const run = promisify(execFile)

const sourceSize = async (
  file: string,
  signal: AbortSignal | undefined
): Promise<ImageSize | undefined> => {
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], {
    signal
  })
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1])
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1])
  return width > 0 && height > 0 ? { width, height } : undefined
}

export const fitImageWithSips = async (input: {
  readonly source:
    | { readonly kind: typeof SIPS_SOURCE.file; readonly file: string }
    | { readonly kind: typeof SIPS_SOURCE.bytes; readonly bytes: Uint8Array }
  readonly format: SipsImageFormat
  readonly limits: Pick<ImageInputLimits, "patchSize" | "fitSide" | "fitPatches"> | undefined
  readonly signal?: AbortSignal | undefined
}): Promise<SipsFittedImage | undefined> => {
  if (process.platform !== PLATFORM.darwin) return undefined
  const directory = await mkdtemp(path.join(tmpdir(), "arden-fit-image-"))
  const file =
    input.source.kind === SIPS_SOURCE.file
      ? input.source.file
      : path.join(directory, `source.${input.format}`)
  const photo = input.format === SIPS_IMAGE_FORMAT.jpeg || input.format === SIPS_IMAGE_FORMAT.heic
  const output = path.join(directory, photo ? "image.jpg" : "image.png")
  try {
    if (input.source.kind === SIPS_SOURCE.bytes) await writeFile(file, input.source.bytes)
    const source = await sourceSize(file, input.signal)
    if (source === undefined) return undefined
    const limits = input.limits
    const size =
      limits === undefined
        ? source
        : fitDimensions(
            source,
            { maxSide: limits.fitSide, maxPatches: limits.fitPatches },
            limits.patchSize
          )
    await run(
      "sips",
      [
        "-s",
        "format",
        photo ? "jpeg" : "png",
        ...(size.width === source.width && size.height === source.height
          ? []
          : ["-z", String(size.height), String(size.width)]),
        file,
        "--out",
        output
      ],
      { signal: input.signal }
    )
    return {
      mediaType: photo ? "image/jpeg" : "image/png",
      data: await readFile(output),
      source,
      size
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
