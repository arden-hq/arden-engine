import { splitAttachedFiles } from "@arden-hq/protocol/chat"
import { Effect, Option, Schema } from "effect"
import path from "node:path"

import type { TranscriptQueries } from "../persistence/transcript/queries.js"
import { ownerText } from "../persistence/transcript/owner-words.js"
import { fileKind } from "./read-binary.js"
import { toolFailure } from "./tool-failure.js"

const AttachedImageSchema = Schema.Struct({
  type: Schema.Literal("image"),
  media_type: Schema.Literals(["image/png", "image/jpeg"]),
  data: Schema.NonEmptyString
})

export type TranscriptFile = {
  readonly sessionId: string
  readonly name: string
  readonly key: string
} & (
  | {
      readonly kind: "image"
      readonly data: string
      readonly mediaType: string
      readonly number: number
    }
  | { readonly kind: "path"; readonly path: string }
)

export const transcriptFiles = async (
  transcript: TranscriptQueries["Service"],
  owners: ReadonlyArray<string>,
  signal: AbortSignal
): Promise<ReadonlyArray<TranscriptFile>> => {
  const files: TranscriptFile[] = []
  let number = 0
  for (const sessionId of owners) {
    let sequence = -1
    while (true) {
      signal.throwIfAborted()
      const page = await Effect.runPromise(
        transcript
          .page({ _tag: "After", sessionId, sequence, limit: 250 })
          .pipe(
            Effect.mapError((cause) => toolFailure(cause, "Chat attachments could not be listed"))
          ),
        { signal }
      )
      for (const record of page.records) {
        const message = record.envelope
        if (message.role !== "user" || message.is_meta === true) continue
        if (Array.isArray(message.content)) {
          for (const [index, block] of message.content.entries()) {
            const image = Schema.decodeUnknownOption(AttachedImageSchema)(block)
            if (Option.isNone(image)) continue
            number += 1
            files.push({
              kind: "image",
              sessionId,
              key: `chat-file:${record.messageId}:${index}`,
              name: `attachment-${number}.${image.value.media_type === "image/png" ? "png" : "jpg"}`,
              mediaType: image.value.media_type,
              data: image.value.data,
              number
            })
          }
        }
        for (const file of splitAttachedFiles(ownerText(message)).files) {
          if (file.directory) continue
          files.push({
            kind: "path",
            sessionId,
            key: `chat-file:${record.messageId}:${file.path}`,
            name: file.name,
            path: file.path
          })
        }
      }
      if (!page.hasMoreAfter || page.lastSequence === null) break
      sequence = page.lastSequence
    }
  }
  return files
}

const EXTENSION_MEDIA: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf"
}

export const fileMediaTypeForName = (name: string): string =>
  EXTENSION_MEDIA[path.extname(name).toLowerCase()] ?? "application/octet-stream"

export const fileMediaType = (bytes: Uint8Array, name: string): string => {
  const kind = fileKind({ bytes, name })
  if (kind.kind === "image") return `image/${kind.format}`
  if (kind.kind === "pdf") return "application/pdf"
  return fileMediaTypeForName(name)
}

const MAX_NAME_CHARS = 120
const MAX_NAME_BYTES = 240

export const safeAttachmentName = (raw: string, fallback: string): string => {
  const leaf = raw.split(/[\\/]/u).at(-1) ?? ""
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f<>:"|?*\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/^[.\s]+/u, "")
    .replace(/[.\s]+$/u, "")
  if (cleaned === "") return fallback
  const extension = path.extname(cleaned).slice(0, 16)
  let stem = path
    .basename(cleaned, path.extname(cleaned))
    .slice(0, MAX_NAME_CHARS - extension.length)
  while (stem !== "" && Buffer.byteLength(`${stem}${extension}`) > MAX_NAME_BYTES) {
    stem = [...stem].slice(0, -1).join("")
  }
  return stem === "" ? fallback : `${stem}${extension}`
}
