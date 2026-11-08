import { formatBytes } from "@arden-hq/std/count"
import { Schema } from "effect"
import { constants } from "node:fs"
import { mkdir, open } from "node:fs/promises"
import { basename, extname, join } from "node:path"

import { readRegularFile } from "../fs/private-store.js"
import type { SharedFileAccess } from "./shared-files.js"
import { safeAttachmentName } from "./shared-file-sources.js"

import { mutationReceiptHost } from "../persistence/tools/mutation-receipt.js"
import type { LocalPathServices } from "../storage/local-paths.js"
import { defineServerTool, type ServerTool } from "./define.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import { requiredAccountRefDescription } from "./google-accounts.js"
import { cwdFor, resolveFor } from "./file-tool-support.js"
import {
  attachmentParts,
  type AttachmentPart,
  GMAIL_API,
  message,
  MAX_EMAIL_ATTACHMENT_BYTES
} from "./google-gmail-mime.js"
import { parseMessageRef } from "./google-gmail-refs.js"
import { decodeGoogle, googleCall } from "./google-request.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { toolRefusal } from "./tool-failure.js"

const SAVE_DIRECTORY = "email-attachments"

const decodeAttachment = decodeGoogle(Schema.Struct({ data: Schema.optionalKey(Schema.String) }), {
  service: "gmail",
  label: "attachment"
})

export const readFullMessage = async ({
  google,
  messageReference,
  signal
}: {
  readonly google: GoogleToolConnections
  readonly messageReference: string
  readonly signal: AbortSignal
}): Promise<{
  readonly account: string
  readonly message: ReturnType<typeof message>
  readonly id: string
}> => {
  const ref = parseMessageRef(messageReference)
  const url = new URL(`${GMAIL_API}/messages/${encodeURIComponent(ref.id)}`)
  url.searchParams.set("format", "full")
  const response = await googleCall({
    google,
    service: "gmail",
    url: url.href,
    accountRef: ref.account,
    signal
  })
  const original = message(response.value)
  if (original.id !== ref.id) {
    throw toolRefusal("Gmail returned a different message.", "Invalid Gmail response")
  }
  return { account: response.account.email, message: original, id: ref.id }
}

/** The bytes of one attachment part: inline data, or Gmail's attachment endpoint. */
export const attachmentBytes = async ({
  google,
  account,
  messageId,
  part,
  signal
}: {
  readonly google: GoogleToolConnections
  readonly account: string
  readonly messageId: string
  readonly part: AttachmentPart
  readonly signal: AbortSignal
}): Promise<Buffer> => {
  if (part.size !== undefined && part.size > MAX_EMAIL_ATTACHMENT_BYTES) {
    throw toolRefusal(
      `${part.filename} is larger than ${formatBytes(MAX_EMAIL_ATTACHMENT_BYTES)}.`,
      "Attachment too large"
    )
  }
  const data =
    part.data ??
    (part.attachmentId === undefined
      ? undefined
      : decodeAttachment(
          (
            await googleCall({
              google,
              service: "gmail",
              url: `${GMAIL_API}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.attachmentId)}`,
              accountRef: account,
              signal
            })
          ).value
        ).data)
  if (data === undefined) {
    throw toolRefusal(`Gmail returned no content for ${part.filename}.`, "Attachment unavailable")
  }
  if (data.length > Math.ceil(MAX_EMAIL_ATTACHMENT_BYTES / 3) * 4 + 2) {
    throw toolRefusal(`${part.filename} is too large to download.`, "Attachment too large")
  }
  if (!/^[A-Za-z0-9_-]*={0,2}$/u.test(data)) {
    throw toolRefusal(
      `Gmail returned invalid attachment content for ${part.filename}.`,
      "Invalid Gmail response"
    )
  }
  const bytes = Buffer.from(data, "base64url")
  if (bytes.toString("base64url") !== data.replace(/=+$/u, "")) {
    throw toolRefusal(
      `Gmail returned invalid attachment content for ${part.filename}.`,
      "Invalid Gmail response"
    )
  }
  if (bytes.byteLength > MAX_EMAIL_ATTACHMENT_BYTES) {
    throw toolRefusal(`${part.filename} is too large to download.`, "Attachment too large")
  }
  return bytes
}

const pickAttachment = (
  parts: ReadonlyArray<AttachmentPart>,
  which: string | number
): AttachmentPart => {
  const listing = parts.map((part) => `${part.index}. ${part.filename}`).join("; ")
  if (parts.length === 0) throw toolRefusal("This message has no attachments.", "No attachments")
  if (typeof which === "number") {
    const found = parts.find((part) => part.index === which)
    if (found === undefined) {
      throw toolRefusal(`No attachment ${which}. Attachments: ${listing}.`, "No such attachment")
    }
    return found
  }
  const matches = parts.filter((part) => part.filename === which)
  const [only] = matches
  if (only === undefined) {
    throw toolRefusal(
      `No attachment named "${which}". Attachments: ${listing}.`,
      "No such attachment"
    )
  }
  if (matches.length > 1) {
    throw toolRefusal(
      `More than one attachment is named "${which}"; pass its number. Attachments: ${listing}.`,
      "Ambiguous attachment"
    )
  }
  return only
}

const writeNew = async (directory: string, name: string, bytes: Buffer): Promise<string> => {
  const extension = extname(name)
  const stem = basename(name, extension)
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const target = join(directory, attempt === 1 ? name : `${stem} (${attempt})${extension}`)
    try {
      const handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o644
      )
      try {
        await handle.writeFile(bytes)
      } finally {
        await handle.close()
      }
      return target
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") throw cause
      const existing = await readRegularFile(target, MAX_EMAIL_ATTACHMENT_BYTES).catch(
        () => undefined
      )
      if (existing !== undefined && sha256Hex(existing.bytes) === sha256Hex(bytes)) return target
    }
  }
  throw toolRefusal("Too many files with this name already exist.", "Name taken")
}

export const gmailAttachmentTool = ({
  google,
  emails,
  paths,
  files
}: {
  readonly google: GoogleToolConnections
  readonly emails: ReadonlyArray<string>
  readonly paths: LocalPathServices
  readonly files: SharedFileAccess
}): ServerTool =>
  defineServerTool({
    name: "email_attachment_save",
    description: [
      `Save one Gmail attachment as a reusable chat file and return its artifact_ref. When a Local folder is available, also save it under ${SAVE_DIRECTORY}/ and return the path.`,
      "Name the attachment by its file name or by its number in the order email_read lists them (1 is the first).",
      `Gmail is only read. Up to ${formatBytes(MAX_EMAIL_ATTACHMENT_BYTES)}.`
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        message_ref: Schema.String.annotate({
          description: requiredAccountRefDescription(
            "gmail",
            "Exact account-qualified message_ref returned by email_search or email_thread_read.",
            emails
          )
        }).check(Schema.isMinLength(3), Schema.isMaxLength(1_024)),
        attachment: Schema.Union([
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))
        ]).annotate({ description: "Attachment file name, or its 1-based number." })
      })
    ),
    metadata: {
      effect: "local_files",
      display_name: "Save Email Attachment",
      kind: "tool",
      action: "write",
      approval_preview: "Save an email attachment to the Local folder.",
      source: "gmail",
      changes_state: true,
      target: "reported",
      concurrency_group: "filesystem",
      destructive: false,
      default_approval: "approve",
      policy_scope: "external",
      permissions: ["email"],
      idempotent: true
    },
    execute: async (input, ctx) => {
      const folder = await cwdFor(paths, ctx)
      const read = await readFullMessage({
        google,
        messageReference: input.message_ref,
        signal: ctx.signal
      })
      const part = pickAttachment(attachmentParts(read.message.payload), input.attachment)
      const bytes = await attachmentBytes({
        google,
        account: read.account,
        messageId: read.id,
        part,
        signal: ctx.signal
      })
      const name = safeAttachmentName(part.filename, `attachment-${part.index}`)
      const saved = await files.publish({
        ctx,
        key: `gmail_attachment:${read.account}:${read.id}:${part.index}:${sha256Hex(bytes)}`,
        name,
        bytes,
        mediaType: part.mimeType
      })
      if (saved.kind !== "snapshot")
        throw toolRefusal("The attachment could not be saved safely.", "Attachment unavailable")
      const directory =
        folder.cwd === null
          ? undefined
          : await resolveFor(folder, SAVE_DIRECTORY, { allowMissing: true, mutation: true })
      if (directory !== undefined) await mkdir(directory, { recursive: true })
      const target = directory === undefined ? undefined : await writeNew(directory, name, bytes)
      return {
        result: `Saved ${part.filename} (${bytes.byteLength} bytes) as ${saved.artifact_ref}${target === undefined ? "." : ` to ${target}.`}`,
        preview: `Saved ${name}`,
        data: {
          ...(target === undefined ? {} : { path: target }),
          artifact_ref: saved.artifact_ref,
          sha256: saved.sha256,
          filename: part.filename,
          mime_type: part.mimeType,
          bytes: bytes.byteLength
        },
        ...(target === undefined
          ? {}
          : {
              host: mutationReceiptHost({
                identity: { runId: ctx.run.runId, toolCallId: ctx.toolCallId },
                outcome: "applied",
                resource: {
                  kind: "file_revision",
                  absolutePath: target,
                  beforeVersion: "absent",
                  afterVersion: sha256Hex(bytes)
                }
              })
            })
      }
    }
  })
