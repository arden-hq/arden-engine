import type { ApprovalMode } from "@arden-hq/protocol/permissions"
import { countOf, formatBytes } from "@arden-hq/std/count"
import { Schema } from "effect"
import { readFile, stat } from "node:fs/promises"

import { mutationReceiptHost } from "../persistence/tools/mutation-receipt.js"
import {
  atomicCompareAndSwap,
  insideLocalFolder,
  pathRuleFor,
  LocalRevisionConflict,
  type LocalPathPolicy,
  type LocalPathServices,
  type SessionPathPolicy
} from "../storage/local-paths.js"
import { boundedDiff, createBoundedDiff, DIFF_UNAVAILABLE } from "./bounded-diff.js"
import { defineServerTool, type ServerApprovalPrompt, type ServerTool } from "./define.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { cwdFor, displayFor, filesystemError, PathSchema, resolveFor } from "./file-tool-support.js"
import { grantData, offerFolderGrant } from "./folder-grant.js"
import type { ServerRunContext } from "./run-context.js"
import { toolRefusal } from "./tool-failure.js"

const MAX_MUTATION_FILE_BYTES = 8 * 1024 * 1024

const WriteParametersSchema = Schema.Struct({
  path: PathSchema,
  content: Schema.String.check(Schema.isMaxLength(MAX_MUTATION_FILE_BYTES)).annotate({
    description:
      "Complete UTF-8 file body, replacing existing content (up to 8,388,608 characters; empty allowed)."
  })
})

const EditParametersSchema = Schema.Struct({
  path: PathSchema,
  old_text: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_MUTATION_FILE_BYTES)
  ).annotate({
    description:
      "Exact non-empty text, up to 8,388,608 characters, that must occur once; add context if ambiguous."
  }),
  new_text: Schema.String.check(Schema.isMaxLength(MAX_MUTATION_FILE_BYTES)).annotate({
    description:
      "Replacement text up to 8,388,608 characters; use an empty string to delete old_text."
  })
})
const writePrompt = async (
  cwd: LocalPathPolicy,
  target: string,
  input: { readonly content: string }
): Promise<ServerApprovalPrompt> => {
  try {
    const before = await readWriteSource(target)
    return {
      preview: `${before.revision === "absent" ? "Create" : "Replace"} ${displayFor(cwd, target)}`,
      diff:
        before.content === undefined || input.content.includes("\0")
          ? DIFF_UNAVAILABLE
          : boundedDiff(displayFor(cwd, target), before.content, input.content),
      data: { path: target, expected_revision: before.revision }
    }
  } catch (cause) {
    throw filesystemError(cause, "prepare a write to", target)
  }
}

const editPrompt = async (
  cwd: LocalPathPolicy,
  target: string,
  input: { readonly old_text: string; readonly new_text: string }
): Promise<ServerApprovalPrompt> => {
  try {
    const before = await readMutationSource(target)
    if (before.revision === "absent") throw toolRefusal(`File not found: ${target}.`, "Not found")
    const matches = before.content.split(input.old_text).length - 1
    if (matches !== 1) {
      throw toolRefusal(
        matches === 0
          ? "The old_text block was not found. Read the file and retry with exact text."
          : `The old_text block matched ${matches} times. Include more context so it is unique.`,
        matches === 0 ? "Text not found" : "Ambiguous edit"
      )
    }
    const after = before.content.replace(input.old_text, () => input.new_text)
    return {
      preview: `Edit ${displayFor(cwd, target)}`,
      diff: boundedDiff(displayFor(cwd, target), before.content, after),
      data: { path: target, expected_revision: before.revision }
    }
  } catch (cause) {
    throw filesystemError(cause, "prepare an edit to", target)
  }
}

const writesWithoutCard = (mode: ApprovalMode, cwd: SessionPathPolicy, target: string): boolean =>
  pathRuleFor(cwd, { lexical: target, real: target }, "change") === "allow" ||
  (mode === "safe" && insideLocalFolder(cwd, target))

const withFolderGrant = async (
  services: LocalPathServices,
  ctx: { readonly run: ServerRunContext; readonly signal: AbortSignal },
  cwd: SessionPathPolicy,
  target: string,
  prompt: ServerApprovalPrompt
): Promise<ServerApprovalPrompt> => {
  if (insideLocalFolder(cwd, target)) return prompt
  const grant = await offerFolderGrant(services, ctx, [target])
  return grant === undefined ? prompt : { ...prompt, data: { ...prompt.data, ...grantData(grant) } }
}

const readMutationSource = async (
  target: string
): Promise<{
  readonly content: string
  readonly revision: string
}> => {
  try {
    const info = await stat(target)
    if (!info.isFile()) throw toolRefusal(`${target} is not a file.`, "Not a file")
    if (info.size > MAX_MUTATION_FILE_BYTES) {
      throw toolRefusal(
        `The existing file is larger than ${formatBytes(MAX_MUTATION_FILE_BYTES)}. Use a narrower edit strategy.`,
        "File too large"
      )
    }
    const bytes = await readFile(target)
    return { content: bytes.toString("utf8"), revision: sha256Hex(bytes) }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { content: "", revision: "absent" }
    }
    throw cause
  }
}

const readWriteSource = async (
  target: string
): Promise<{ readonly content: string | undefined; readonly revision: string }> => {
  try {
    const bytes = await readFile(target)
    const content = bytes.length <= MAX_MUTATION_FILE_BYTES ? bytes.toString("utf8") : ""
    const text =
      bytes.length <= MAX_MUTATION_FILE_BYTES &&
      !bytes.includes(0) &&
      Buffer.from(content, "utf8").equals(bytes)
    return { content: text ? content : undefined, revision: sha256Hex(bytes) }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { content: "", revision: "absent" }
    }
    throw cause
  }
}

const approvalRevision = (
  ctx: { readonly approval?: { readonly data?: Readonly<Record<string, unknown>> } },
  target: string
): string | null => {
  const data = ctx.approval?.data
  if (data === undefined) return null
  if (data.path !== target || typeof data.expected_revision !== "string") {
    throw toolRefusal("The approved file target no longer matches this call.", "Approval mismatch")
  }
  return data.expected_revision
}

export const fileWriteTools = (services: LocalPathServices): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "file_write",
    description: [
      "Create or fully replace one UTF-8 file atomically after approval.",
      "The reviewed revision must still match when approval resumes; read and retry after a conflict.",
      "Use file_edit for a localized change to an existing file.",
      "A missing parent folder is an error; create it first."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(WriteParametersSchema),
    metadata: {
      display: { card: "file_change", result: "applied_edit" },
      effect: "local_files",
      local_target: { arg: "path", kind: "file" },
      display_name: "Write File",
      kind: "filesystem",
      action: "write",
      approval_preview: "Create or replace a local file.",
      source: "_filesystem",
      changes_state: true,
      target: "reported",
      concurrency_group: "filesystem",
      destructive: false,
      default_approval: "ask",
      approval_bypass: true,
      idempotent: true
    },
    approvalRequirement: async (input, ctx) => {
      const cwd = await cwdFor(services, ctx)
      const target = await resolveFor(cwd, input.path, { allowMissing: true, mutation: true })
      return writesWithoutCard(ctx.run.approvalMode, cwd, target)
        ? undefined
        : withFolderGrant(services, ctx, cwd, target, await writePrompt(cwd, target, input))
    },
    approvalPrompt: async (input, ctx) => {
      const cwd = await cwdFor(services, ctx)
      const target = await resolveFor(cwd, input.path, { allowMissing: true, mutation: true })
      return withFolderGrant(services, ctx, cwd, target, await writePrompt(cwd, target, input))
    },
    execute: async (input, ctx) => {
      const cwd = await cwdFor(services, ctx)
      const target = await resolveFor(cwd, input.path, { allowMissing: true, mutation: true })
      try {
        const before = await readWriteSource(target)
        const expected = approvalRevision(ctx, target) ?? before.revision
        const current = before.revision
        if (current !== expected) throw new LocalRevisionConflict()
        const desired = sha256Hex(input.content)
        const lines = input.content.length === 0 ? 0 : input.content.split("\n").length
        if (current === desired) {
          return {
            result: `No changes to ${displayFor(cwd, target)}.`,
            preview: "No changes",
            data: {
              path: displayFor(cwd, target),
              absolute_path: target,
              lines,
              bytes: Buffer.byteLength(input.content, "utf8"),
              revision: current
            },
            host: mutationReceiptHost({
              identity: { runId: ctx.run.runId, toolCallId: ctx.toolCallId },
              outcome: "no_op",
              resource: {
                kind: "file_revision",
                absolutePath: target,
                beforeVersion: current,
                afterVersion: current
              }
            })
          }
        }
        const appliedDiff =
          before.content === undefined || input.content.includes("\0")
            ? undefined
            : createBoundedDiff(displayFor(cwd, target), before.content, input.content)
        const written = await atomicCompareAndSwap(target, input.content, expected)
        return {
          result: `Wrote ${displayFor(cwd, target)} (${countOf(lines, "line")}).`,
          preview: `Wrote ${countOf(lines, "line")}`,
          data: {
            path: displayFor(cwd, target),
            absolute_path: target,
            lines,
            bytes: written.bytes,
            revision: written.revision,
            ...(appliedDiff === undefined
              ? {}
              : {
                  applied_change: {
                    type: "file_edit",
                    path: displayFor(cwd, target),
                    patch: appliedDiff.patch,
                    truncated: appliedDiff.truncated,
                    additions: appliedDiff.additions,
                    deletions: appliedDiff.deletions,
                    before_revision: current,
                    after_revision: written.revision
                  }
                })
          },
          host: mutationReceiptHost({
            identity: { runId: ctx.run.runId, toolCallId: ctx.toolCallId },
            outcome: "applied",
            resource: {
              kind: "file_revision",
              absolutePath: target,
              beforeVersion: current,
              afterVersion: written.revision
            }
          })
        }
      } catch (cause) {
        throw filesystemError(cause, "write", target)
      }
    }
  }),

  defineServerTool({
    name: "file_edit",
    description: [
      "Replace one exact, unique text block in an existing UTF-8 file after approval.",
      "Call file_read first; if old_text is missing or ambiguous, retry with current text and more surrounding context.",
      "The reviewed revision must still match when approval resumes. Use file_write for creation or full replacement."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(EditParametersSchema),
    metadata: {
      display: { card: "file_change", result: "applied_edit" },
      effect: "local_files",
      local_target: { arg: "path", kind: "file" },
      display_name: "Edit File",
      kind: "filesystem",
      action: "write",
      approval_preview: "Edit a local file.",
      source: "_filesystem",
      changes_state: true,
      target: "reported",
      concurrency_group: "filesystem",
      destructive: false,
      default_approval: "ask",
      approval_bypass: true,
      idempotent: false
    },
    approvalRequirement: async (input, ctx) => {
      const cwd = await cwdFor(services, ctx)
      const target = await resolveFor(cwd, input.path, { mutation: true })
      return writesWithoutCard(ctx.run.approvalMode, cwd, target)
        ? undefined
        : withFolderGrant(services, ctx, cwd, target, await editPrompt(cwd, target, input))
    },
    approvalPrompt: async (input, ctx) => {
      const cwd = await cwdFor(services, ctx)
      const target = await resolveFor(cwd, input.path, { mutation: true })
      return withFolderGrant(services, ctx, cwd, target, await editPrompt(cwd, target, input))
    },
    execute: async (input, ctx) => {
      const cwd = await cwdFor(services, ctx)
      const target = await resolveFor(cwd, input.path, { mutation: true })
      try {
        const before = await readMutationSource(target)
        if (before.revision === "absent")
          throw toolRefusal(`File not found: ${target}.`, "Not found")
        const matches = before.content.split(input.old_text).length - 1
        if (matches !== 1) {
          throw toolRefusal(
            matches === 0
              ? "The old_text block was not found. Read the file and retry with exact text."
              : `The old_text block matched ${matches} times. Include more context so it is unique.`,
            matches === 0 ? "Text not found" : "Ambiguous edit"
          )
        }
        const expected = approvalRevision(ctx, target) ?? before.revision
        const after = before.content.replace(input.old_text, () => input.new_text)
        const displayedPath = displayFor(cwd, target)
        if (after === before.content) {
          return {
            result: `No changes to ${displayedPath}.`,
            preview: "No changes",
            data: {
              path: displayedPath,
              absolute_path: target,
              bytes: Buffer.byteLength(before.content, "utf8"),
              revision: before.revision
            },
            host: mutationReceiptHost({
              identity: { runId: ctx.run.runId, toolCallId: ctx.toolCallId },
              outcome: "no_op",
              resource: {
                kind: "file_revision",
                absolutePath: target,
                beforeVersion: before.revision,
                afterVersion: before.revision
              }
            })
          }
        }
        const appliedDiff = createBoundedDiff(displayedPath, before.content, after)
        const written = await atomicCompareAndSwap(target, after, expected)
        return {
          result: `Edited ${displayedPath}.${appliedDiff === undefined ? ` ${DIFF_UNAVAILABLE}` : ""}`,
          preview: "File edited",
          data: {
            path: displayedPath,
            absolute_path: target,
            bytes: written.bytes,
            revision: written.revision,
            ...(appliedDiff === undefined
              ? {}
              : {
                  applied_change: {
                    type: "file_edit",
                    path: displayedPath,
                    patch: appliedDiff.patch,
                    truncated: appliedDiff.truncated,
                    additions: appliedDiff.additions,
                    deletions: appliedDiff.deletions,
                    before_revision: before.revision,
                    after_revision: written.revision
                  }
                })
          },
          host: mutationReceiptHost({
            identity: { runId: ctx.run.runId, toolCallId: ctx.toolCallId },
            outcome: "applied",
            resource: {
              kind: "file_revision",
              absolutePath: target,
              beforeVersion: before.revision,
              afterVersion: written.revision
            }
          })
        }
      } catch (cause) {
        throw filesystemError(cause, "edit", target)
      }
    }
  })
]
