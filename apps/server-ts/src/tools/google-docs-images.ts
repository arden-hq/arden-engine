import type { ImageInput, ModelContentBlock } from "@arden-hq/loop"
import { WEB_PROTOCOL } from "@arden-hq/std/url"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { DocumentImage } from "./google-docs-document.js"
import { FILE_KIND, fileKind, imageForModel, type ModelImage } from "./read-binary.js"

const MAX_DOCUMENT_IMAGES = 8

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

const GOOGLE_CONTENT_HOST = "googleusercontent.com"

const isGoogleContent = (address: string): boolean => {
  const url = URL.parse(address)
  return (
    url !== null &&
    url.protocol === WEB_PROTOCOL.https &&
    (url.hostname === GOOGLE_CONTENT_HOST || url.hostname.endsWith(`.${GOOGLE_CONTENT_HOST}`))
  )
}

const imageBytes = async (
  address: string,
  signal: AbortSignal
): Promise<Uint8Array | undefined> => {
  let current = address
  let response = await fetch(current, { signal, redirect: "manual" })
  for (let hops = 0; hops < 3 && response.status >= 300 && response.status < 400; hops += 1) {
    const next = URL.parse(response.headers.get("location") ?? "", current)?.href
    if (next === undefined || !isGoogleContent(next)) return undefined
    current = next
    response = await fetch(current, { signal, redirect: "manual" })
  }
  if (!response.ok) return undefined
  const length = Number(response.headers.get("content-length"))
  if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) return undefined
  const bytes = new Uint8Array(await response.arrayBuffer())
  return bytes.byteLength > MAX_IMAGE_BYTES ? undefined : bytes
}

export interface DocumentImages {
  readonly content: ReadonlyArray<ModelContentBlock>
  readonly note: string
}

const IMAGE_OUTCOME = {
  attached: "attached",
  not_fetched: "not_fetched",
  not_converted: "not_converted",
  over_cap: "over_cap"
} as const

type Outcome =
  | {
      readonly kind: typeof IMAGE_OUTCOME.attached
      readonly marker: string
      readonly image: ModelImage
    }
  | {
      readonly kind:
        | typeof IMAGE_OUTCOME.not_fetched
        | typeof IMAGE_OUTCOME.not_converted
        | typeof IMAGE_OUTCOME.over_cap
      readonly marker: string
    }

const markersOf = (outcomes: ReadonlyArray<Outcome>, kind: Outcome["kind"]): string =>
  outcomes
    .filter((outcome) => outcome.kind === kind)
    .map((outcome) => outcome.marker)
    .join(", ")

const noteFor = (
  outcomes: ReadonlyArray<Outcome>,
  drawings: ReadonlyArray<DocumentImage>
): string =>
  [
    ["attached", "Attached below, in order:"],
    ["not_fetched", "Not attached, because Google did not serve them:"],
    ["not_converted", "Not attached, because they could not be converted for the model here:"],
    [
      "over_cap",
      `Not attached, because a page attaches at most ${MAX_DOCUMENT_IMAGES} images (read a smaller limit to see them):`
    ]
  ]
    .flatMap(([kind, lead]) => {
      const markers = markersOf(outcomes, kind as Outcome["kind"])
      return markers === "" ? [] : [`${lead} ${markers}.`]
    })
    .concat(
      drawings.length === 0
        ? []
        : [
            `Drawings and charts cannot be shown: ${drawings.map((image) => image.marker).join(", ")}.`
          ]
    )
    .join("\n")

export const documentImagesForModel = async (input: {
  readonly images: ReadonlyArray<DocumentImage>
  readonly imageInput: ImageInput | undefined
  readonly signal: AbortSignal
}): Promise<DocumentImages> => {
  const pictures = input.images.filter((image) => image.contentUri !== undefined)
  const drawings = input.images.filter((image) => image.contentUri === undefined)
  if (pictures.length === 0) return { content: [], note: noteFor([], drawings) }
  if (input.imageInput === undefined)
    return {
      content: [],
      note: "The model on this chat cannot receive images, so the images marked above are not attached."
    }
  const limits = input.imageInput.limits
  const directory = await mkdtemp(path.join(tmpdir(), "arden-doc-image-"))
  try {
    const outcomes = await Promise.all(
      pictures.map(async (picture, index): Promise<Outcome> => {
        const marker = picture.marker
        if (index >= MAX_DOCUMENT_IMAGES) return { kind: "over_cap", marker }
        const address = picture.contentUri
        if (address === undefined || !isGoogleContent(address))
          return { kind: "not_fetched", marker }
        const bytes = await imageBytes(address, input.signal).catch((cause: unknown) => {
          if (input.signal.aborted) throw cause
          return undefined
        })
        if (bytes === undefined) return { kind: "not_fetched", marker }
        const kind = fileKind({ bytes, name: "image" })
        if (kind.kind !== FILE_KIND.image) return { kind: "not_fetched", marker }
        const file = path.join(directory, `image-${index}`)
        await writeFile(file, bytes)
        const image = await imageForModel({
          file,
          bytes,
          format: kind.format,
          limits,
          signal: input.signal
        })
        return image === undefined
          ? { kind: "not_converted", marker }
          : { kind: "attached", marker, image }
      })
    )
    return {
      content: outcomes.flatMap((outcome) =>
        outcome.kind === IMAGE_OUTCOME.attached
          ? [
              {
                type: "image" as const,
                media_type: outcome.image.mediaType,
                data: outcome.image.data.toString("base64")
              }
            ]
          : []
      ),
      note: noteFor(outcomes, drawings)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
