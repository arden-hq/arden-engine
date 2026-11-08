import type { ImageInputLimits, ModelContentBlock } from "@arden-hq/loop"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { DocumentImage } from "./google-docs-document.js"
import { fileKind, imageForModel, type ModelImage } from "./read-binary.js"

const MAX_DOCUMENT_IMAGES = 8

/** A Docs image is at most this large on the wire; Google caps uploads at 50 MB. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Docs serves image bytes only from Google's content hosts. */
const isGoogleContent = (address: string): boolean => {
  const url = URL.parse(address)
  return (
    url !== null &&
    url.protocol === "https:" &&
    (url.hostname === "googleusercontent.com" || url.hostname.endsWith(".googleusercontent.com"))
  )
}

const imageBytes = async (
  address: string,
  signal: AbortSignal
): Promise<Uint8Array | undefined> => {
  // A redirect may move between Google's content hosts, never off them.
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

type Outcome =
  | { readonly kind: "attached"; readonly marker: string; readonly image: ModelImage }
  | { readonly kind: "not_fetched" | "not_converted" | "over_cap"; readonly marker: string }

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
  readonly limits: ImageInputLimits | undefined
  readonly signal: AbortSignal
}): Promise<DocumentImages> => {
  const pictures = input.images.filter((image) => image.contentUri !== undefined)
  const drawings = input.images.filter((image) => image.contentUri === undefined)
  if (pictures.length === 0) return { content: [], note: noteFor([], drawings) }
  if (input.limits === undefined)
    return {
      content: [],
      note: "The model on this chat cannot receive images, so the images marked above are not attached."
    }
  const limits = input.limits
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
        if (kind.kind !== "image") return { kind: "not_fetched", marker }
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
        outcome.kind === "attached"
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
