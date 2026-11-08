import type { ImageInputLimits } from "@arden-hq/loop"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { fitDimensions, type ImageSize } from "./prompt-image.js"

export type SipsImageFormat = "png" | "jpeg" | "gif" | "webp" | "heic"

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
    | { readonly kind: "file"; readonly file: string }
    | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  readonly format: SipsImageFormat
  readonly limits: Pick<ImageInputLimits, "patchSize" | "fitSide" | "fitPatches">
  readonly signal?: AbortSignal | undefined
}): Promise<SipsFittedImage | undefined> => {
  if (process.platform !== "darwin") return undefined
  const directory = await mkdtemp(path.join(tmpdir(), "arden-fit-image-"))
  const file =
    input.source.kind === "file"
      ? input.source.file
      : path.join(directory, `source.${input.format}`)
  const photo = input.format === "jpeg" || input.format === "heic"
  const output = path.join(directory, photo ? "image.jpg" : "image.png")
  try {
    if (input.source.kind === "bytes") await writeFile(file, input.source.bytes)
    const source = await sourceSize(file, input.signal)
    if (source === undefined) return undefined
    const size = fitDimensions(
      source,
      { maxSide: input.limits.fitSide, maxPatches: input.limits.fitPatches },
      input.limits.patchSize
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
