import { countOf } from "@arden-hq/std/count"
import type { ImageInputLimits } from "@arden-hq/loop"
import path from "node:path"
import { extractText, getDocumentProxy } from "unpdf"

import { fitPng, fitsLimits, imageSize, patchCount, type ImageSize } from "../lib/prompt-image.js"
import { fitImageWithSips } from "../lib/image-fit-sips.js"

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "heic"

export type FileKind =
  | { readonly kind: "text" }
  | { readonly kind: "pdf" }
  | { readonly kind: "image"; readonly format: ImageFormat }
  | { readonly kind: "binary"; readonly label: string }

/** Git's rule: a NUL byte in the first 8 KB marks a file as binary. */
const SNIFF_BYTES = 8_000

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, at = 0): boolean =>
  signature.every((byte, index) => bytes[at + index] === byte)

const ascii = (bytes: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...bytes.subarray(from, to))

/** HEIF stills (HEIC from an iPhone) open with an `ftyp` box naming one of these brands. */
const HEIF_BRANDS: ReadonlySet<string> = new Set(["heic", "heix", "heim", "heis", "mif1", "msf1"])

const imageFormat = (bytes: Uint8Array): ImageFormat | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg"
  if (ascii(bytes, 0, 4) === "GIF8") return "gif"
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp"
  if (ascii(bytes, 4, 8) === "ftyp" && HEIF_BRANDS.has(ascii(bytes, 8, 12))) return "heic"
  return undefined
}

const BINARY_LABELS: Readonly<Record<string, string>> = {
  ".doc": "a Word document",
  ".docx": "a Word document",
  ".xls": "an Excel spreadsheet",
  ".xlsx": "an Excel spreadsheet",
  ".ppt": "a PowerPoint presentation",
  ".pptx": "a PowerPoint presentation",
  ".zip": "a ZIP archive"
}

const binaryLabel = (bytes: Uint8Array, name: string): string => {
  const extension = path.extname(name).toLowerCase()
  const known = BINARY_LABELS[extension]
  if (known !== undefined) return known
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "a ZIP archive"
  return extension.length > 1 ? `a binary ${extension} file` : "a binary file"
}

export const fileKind = (input: {
  readonly bytes: Uint8Array
  readonly name: string
}): FileKind => {
  const { bytes } = input
  if (ascii(bytes, 0, 5) === "%PDF-") return { kind: "pdf" }
  const format = imageFormat(bytes)
  if (format !== undefined) return { kind: "image", format }
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) {
    return { kind: "binary", label: binaryLabel(bytes, input.name) }
  }
  return { kind: "text" }
}

export const binaryRefusal = (name: string, label: string): string =>
  `${name} is ${label}, not text, so file_read cannot read it; use exec_command to convert it to text first.`

export type PdfText =
  | { readonly kind: "text"; readonly text: string; readonly pages: number }
  | { readonly kind: "no_text"; readonly pages: number }
  | { readonly kind: "locked" }
  | { readonly kind: "unreadable" }

export const readPdfText = async (bytes: Uint8Array): Promise<PdfText> => {
  let document: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    // pdf.js takes ownership of the buffer it is given; hand it a copy.
    document = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 })
  } catch (cause) {
    return cause instanceof Error && cause.name === "PasswordException"
      ? { kind: "locked" }
      : { kind: "unreadable" }
  }
  try {
    const { totalPages, text } = await extractText(document, { mergePages: false })
    if (text.every((page) => page.trim().length === 0)) {
      return { kind: "no_text", pages: totalPages }
    }
    return {
      kind: "text",
      pages: totalPages,
      text: text
        .map(
          (page, index) =>
            `[Page ${index + 1} of ${totalPages}]\n${page.trim() || "(This page has no text layer.)"}\n`
        )
        .join("\n")
    }
  } catch {
    return { kind: "unreadable" }
  } finally {
    await document.loadingTask.destroy()
  }
}

export const pdfRefusal = (
  name: string,
  outcome: Exclude<PdfText, { readonly kind: "text" }>,
  imagesShown: boolean
): string => {
  switch (outcome.kind) {
    case "locked":
      return `${name} is a password-protected PDF, so file_read cannot read its text.`
    case "unreadable":
      return `${name} starts like a PDF but could not be parsed, so file_read cannot read its text.`
    case "no_text":
      return [
        `${name} is a PDF of ${countOf(outcome.pages, "page")} with no text layer (it is probably scanned), so it has no text to read.`,
        ...(imagesShown
          ? [
              "To see it, render its pages to PNG files with exec_command and read those images with file_read."
            ]
          : [])
      ].join(" ")
  }
}

export interface ModelImage {
  readonly mediaType: "image/png" | "image/jpeg"
  readonly data: Buffer
  readonly source: ImageSize
  readonly size: ImageSize
}

const FORMAT_NAMES: Record<ImageFormat, string> = {
  png: "PNG",
  jpeg: "JPEG",
  gif: "GIF",
  webp: "WebP",
  heic: "HEIC"
}

export const imageRefusal = (name: string, format: ImageFormat): string =>
  `${name} is a ${FORMAT_NAMES[format]} image, and the model on this chat cannot receive images, so file_read cannot show it.`

export const imageConversionRefusal = (name: string, format: ImageFormat): string =>
  `${name} is a ${FORMAT_NAMES[format]} image that could not be converted for the model here.`

export const imageForModel = async (input: {
  readonly file: string
  readonly bytes: Uint8Array
  readonly format: ImageFormat
  readonly limits: ImageInputLimits
  readonly signal: AbortSignal
}): Promise<ModelImage | undefined> => {
  const fits = (size: ImageSize): boolean =>
    fitsLimits(
      size,
      { maxSide: input.limits.fitSide, maxPatches: input.limits.fitPatches },
      input.limits.patchSize
    )
  const direct = (): ModelImage | undefined => {
    if (input.format === "png") return fitPng({ bytes: input.bytes, limits: input.limits })
    if (input.format !== "jpeg") return undefined
    const size = imageSize(input.bytes, "image/jpeg")
    return size !== undefined && fits(size)
      ? { mediaType: "image/jpeg", data: Buffer.from(input.bytes), source: size, size }
      : undefined
  }
  const image =
    direct() ??
    (await fitImageWithSips({
      source: { kind: "file", file: input.file },
      format: input.format,
      limits: input.limits,
      signal: input.signal
    }).catch((cause: unknown) => {
      if (input.signal.aborted) throw cause
      return undefined
    }))
  return image !== undefined &&
    patchCount(image.size, input.limits.patchSize) <= input.limits.maxPatches
    ? image
    : undefined
}

export const imageNote = (name: string, format: ImageFormat, image: ModelImage): string => {
  const { source, size } = image
  const shown =
    source.width === size.width && source.height === size.height
      ? ""
      : `, shown at ${size.width}x${size.height}`
  return `${name} is a ${source.width}x${source.height} ${FORMAT_NAMES[format]} image${shown}. It is attached below.`
}
