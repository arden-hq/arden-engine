import { formatBytes } from "@arden-hq/std/count"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import {
  createSharedFileAccess,
  fileOwnerSessions,
  sharedFileServices,
  type SharedFileServices
} from "./shared-files.js"
import { transcriptFiles, type TranscriptFile } from "./shared-file-sources.js"
import { toolFailure } from "./tool-failure.js"

type ListedFile = {
  readonly name: string
  readonly size?: number
  readonly media_type?: string
  readonly artifact_ref?: string
  readonly path?: string
  readonly attachment?: number
  readonly sha256?: string
}
type Entry =
  | { readonly kind: "attached"; readonly source: TranscriptFile }
  | { readonly kind: "artifact"; readonly file: ListedFile }

const makeChatFilesListTool = (services: SharedFileServices): ServerTool => {
  const files = createSharedFileAccess(services)
  return defineServerTool({
    name: "chat_files_list",
    description: [
      "List this chat's attached screenshots, attached file paths, and reusable generated or downloaded files.",
      "Returns metadata and stable artifact_ref values that email, Drive, and browser upload tools accept.",
      "Uses the complete chat history, including attachments older than the current model context.",
      "Does not download content from Gmail or Drive; use their attachment metadata and download tools first."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
          Schema.withDecodingDefault(Effect.succeed(0))
        ),
        limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(
          Schema.withDecodingDefault(Effect.succeed(50))
        )
      })
    ),
    metadata: {
      effect: "none",
      display_name: "List chat files",
      kind: "filesystem",
      action: "read",
      approval_preview: "List files available in this chat.",
      source: "_filesystem",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (input, ctx) => {
      const owners = await fileOwnerSessions(services, ctx)
      const attached = await transcriptFiles(services.transcript, [ctx.run.sessionId], ctx.signal)
      const entries: Entry[] = attached.map((source) => ({ kind: "attached", source }))
      const attachmentKeys = new Set(attached.map((file) => file.key))
      const seen = new Set<string>()
      for (const owner of owners) {
        const artifacts = await Effect.runPromise(
          services.artifacts
            .list(owner)
            .pipe(Effect.mapError((cause) => toolFailure(cause, "Chat files could not be listed"))),
          { signal: ctx.signal }
        )
        for (const artifact of artifacts) {
          if (seen.has(artifact.ref) || artifact.kind === "html") continue
          seen.add(artifact.ref)
          if (owner === ctx.run.sessionId && attachmentKeys.has(artifact.operation_key ?? ""))
            continue
          entries.push({
            kind: "artifact",
            file: {
              name: artifact.filename,
              size: artifact.byte_length,
              media_type: artifact.media_type,
              artifact_ref: artifact.ref,
              sha256: artifact.sha256
            }
          })
        }
      }
      const page: ListedFile[] = []
      for (const entry of entries.slice(input.offset, input.offset + input.limit)) {
        if (entry.kind === "artifact") {
          page.push(entry.file)
          continue
        }
        const source = entry.source
        if (source.kind === "path") {
          page.push({ name: source.name, path: source.path })
          continue
        }
        const file = await files.publish({
          ctx,
          key: source.key,
          name: source.name,
          bytes: Buffer.from(source.data, "base64"),
          mediaType: source.mediaType
        })
        if (file.kind === "snapshot")
          page.push({
            name: file.name,
            size: file.size,
            media_type: file.media_type,
            artifact_ref: file.artifact_ref,
            attachment: source.number,
            sha256: file.sha256
          })
      }
      const next = input.offset + page.length < entries.length ? input.offset + page.length : null
      return {
        result:
          page.length === 0
            ? "No files are available in this chat."
            : page
                .map(
                  (file) =>
                    `${file.name}${file.size === undefined ? "" : ` (${formatBytes(file.size)})`}: ${file.artifact_ref ?? file.path}`
                )
                .join("\n"),
        preview: `${page.length} chat files`,
        data: { files: page, next_offset: next }
      }
    }
  })
}

export const chatFilesTools = Effect.gen(function* () {
  return [makeChatFilesListTool(yield* sharedFileServices)]
})
