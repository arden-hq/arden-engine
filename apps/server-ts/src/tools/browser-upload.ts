import { APPROVAL_FIELD_LABEL } from "@arden-hq/protocol/chat"
import { formatBytes } from "@arden-hq/std/count"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"
import { Effect, Schema } from "effect"

import { BrowserClient, MAX_UPLOAD_FILES } from "../browser/service.js"
import type { JsonObject } from "../persistence/json.js"
import {
  browserOutput,
  OriginSchema,
  originIssues,
  ProfileRefSchema,
  claimObservedRevision,
  runBrowserForRun,
  TabRefSchema
} from "./browser-support.js"
import { withPageAfter } from "./browser-page.js"
import { nodeRefSchema, PageAfterSchema, SnapshotRefSchema } from "./browser-parameters.js"
import {
  FileRefSchema,
  PreparedFileSchema,
  createSharedFileAccess,
  preparedFilesApproval,
  sharedFileServices,
  type PreparedFile,
  type ResolvedFile,
  type SharedFileAccess,
  type SharedFileServices
} from "./shared-files.js"
import type { ServerRunContext } from "./run-context.js"
import { defineServerTool, type ServerApprovalPrompt, type ServerTool } from "./define.js"
import { grantData, offerFolderGrant, type FolderGrant } from "./folder-grant.js"

const UploadParametersSchema = Schema.Struct({
  tab_ref: TabRefSchema.annotate({
    description: "Tab of the latest interactive snapshot, the one that shows the file field."
  }),
  profile_ref: ProfileRefSchema.annotate({
    description: "Exact profile_ref for the snapshotted tab; it must still match at execution."
  }),
  origin: OriginSchema.annotate({
    description: "Exact current HTTP(S) origin of the tab, such as https://example.com."
  }),
  node_ref: nodeRefSchema(
    "The @eN ref of the file field (or its upload button) from that snapshot."
  ),
  files: Schema.Array(FileRefSchema)
    .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_UPLOAD_FILES))
    .annotate({
      description: `1-${MAX_UPLOAD_FILES} files to put in the field; each is a path, an artifact_ref, or an attachment number.`
    }),
  snapshot_ref: SnapshotRefSchema,
  snapshot: Schema.optionalKey(PageAfterSchema)
}).check(Schema.makeFilter((input) => originIssues(input.origin)))

const isUploadApproval = Schema.is(
  Schema.Struct({
    tab_ref: Schema.String,
    profile_ref: Schema.String,
    origin: Schema.String,
    node_ref: Schema.String,
    snapshot_ref: Schema.String,
    expected_revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    files: Schema.Array(PreparedFileSchema)
  })
)

interface UploadServices extends SharedFileServices {
  readonly browser: BrowserClient["Service"]
}

const makeBrowserUploadTool = (services: UploadServices): ServerTool => {
  const files = createSharedFileAccess(services)
  return defineServerTool({
    name: "browser_upload",
    description: [
      "Put one or more files into a file field on a page, authorized by the latest interactive snapshot of the same tab (like browser_act).",
      "Files can be images the user attached in this chat, files Arden made (artifact_ref or managed-output reference), or files on this Mac by path.",
      "An upload sends the file to the site: it follows the user's rules and approval mode like any other send, so use it only when the user wants that file on that site.",
      "A file outside the Local folders is fine to ask for: the user's card names its path and lets them upload it once or add its folder. Call the tool rather than asking the user to attach or move the file.",
      "Hidden files, keys and credentials, and Arden's own data are refused; tell the user the reason.",
      "Uploading fills the field only; submitting the form is a separate browser_act, built from the page this call returns."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(UploadParametersSchema),
    metadata: {
      effect: "external",
      display_name: "Upload file",
      kind: "browser",
      action: "execute",
      approval_preview: "Upload a file to this site.",
      source: "_browser",
      changes_state: true,
      target: "reported",
      concurrency_group: "browser",
      destructive: false,
      default_approval: "ask",
      refuse_unattended: true,
      policy_scope: "external",
      open_world: true,
      idempotent: false,
      code_mode: false
    },
    impact: () => ({ kind: "outward", category: "external_send" }),
    site: (input) => input.origin,
    approvalRequirement: async (input, ctx) => {
      const prepared = await prepareUpload(files, input, ctx)
      return prepared.some((file) => file.kind === "outside")
        ? uploadPrompt(services, input, ctx, prepared)
        : undefined
    },
    approvalPrompt: async (input, ctx) =>
      uploadPrompt(services, input, ctx, await prepareUpload(files, input, ctx)),
    execute: async (input, ctx, effects) => {
      const approved = ctx.approval?.data
      const expectedRevision =
        ctx.approval === undefined ? undefined : approvedRevision(input, approved)
      const approvedFiles = await files.forExecution({
        ctx,
        refs: input.files,
        key: ctx.toolCallId,
        intent: uploadIntent(input)
      })
      const staged = await stageFiles(approvedFiles)
      try {
        const uploaded = await runBrowserForRun(
          services.browser,
          ctx,
          {
            type: "upload",
            tabRef: input.tab_ref,
            profileRef: input.profile_ref,
            origin: input.origin,
            expectedRevision:
              expectedRevision ??
              claimObservedRevision(
                ctx.run.browserObservations,
                input.tab_ref,
                input.snapshot_ref,
                ctx.toolCallId
              ),
            nodeRef: input.node_ref,
            files: staged.paths
          },
          ctx.signal,
          { effects }
        )
        return browserOutput(
          await withPageAfter(services.browser, ctx, uploaded, {
            tabRef: input.tab_ref,
            after: input.snapshot,
            navigates: false
          })
        )
      } finally {
        await staged.cleanup()
      }
    }
  })
}

type UploadInput = typeof UploadParametersSchema.Type
type UploadCtx = ToolContext<ServerRunContext>

const uploadIntent = (input: UploadInput): JsonObject => ({
  tab_ref: input.tab_ref,
  profile_ref: input.profile_ref,
  origin: input.origin,
  node_ref: input.node_ref,
  snapshot_ref: input.snapshot_ref
})

const prepareUpload = (
  files: SharedFileAccess,
  input: UploadInput,
  ctx: UploadCtx
): Promise<ReadonlyArray<PreparedFile>> =>
  files.prepare({ ctx, refs: input.files, key: ctx.toolCallId, allowOutside: true })

const uploadPrompt = async (
  services: UploadServices,
  input: UploadInput,
  ctx: UploadCtx,
  prepared: ReadonlyArray<PreparedFile>
): Promise<ServerApprovalPrompt> => {
  const outside = prepared.filter((file) => file.kind === "outside")
  const grant =
    outside.length === 0
      ? undefined
      : await offerFolderGrant(
          services,
          ctx,
          outside.map((file) => file.path)
        )
  return uploadCard({
    origin: input.origin,
    files: prepared,
    grant,
    data: {
      ...uploadIntent(input),
      expected_revision:
        ctx.approval === undefined
          ? claimObservedRevision(
              ctx.run.browserObservations,
              input.tab_ref,
              input.snapshot_ref,
              ctx.toolCallId
            )
          : approvedRevision(input, ctx.approval.data),
      files: prepared,
      shared_files: preparedFilesApproval({
        key: ctx.toolCallId,
        refs: input.files,
        files: prepared,
        intent: uploadIntent(input)
      }),
      ...(outside.length === 0 ? {} : { reviewer: "user" })
    }
  })
}

const approvedRevision = (input: UploadInput, approved: unknown): number => {
  if (
    !isUploadApproval(approved) ||
    approved.tab_ref !== input.tab_ref ||
    approved.profile_ref !== input.profile_ref ||
    approved.origin !== input.origin ||
    approved.node_ref !== input.node_ref ||
    approved.snapshot_ref !== input.snapshot_ref
  )
    throw new ToolExecutionError("This upload's card named another tab or site.", {
      preview: "Card mismatch",
      retryable: false
    })
  return approved.expected_revision
}

const uploadCard = ({
  origin,
  files,
  grant,
  data
}: {
  readonly origin: string
  readonly files: ReadonlyArray<PreparedFile>
  readonly grant: FolderGrant | undefined
  readonly data: JsonObject
}): ServerApprovalPrompt => {
  const site = new URL(origin).host
  const outside = files.some((file) => file.kind === "outside")
  return {
    preview: `Upload ${files.map((file) => file.name).join(", ")} to ${site}`,
    presentation: {
      title: `Upload ${files.length === 1 ? "a file" : `${files.length} files`} to ${site}?`,
      fields: [
        ...files.flatMap((file) => [
          { label: "File", value: `${file.name} · ${formatBytes(file.size)}` },
          ...(file.kind === "outside" ? [{ label: "Path", value: file.path }] : [])
        ]),
        { label: APPROVAL_FIELD_LABEL.site, value: origin }
      ],
      approve_label: outside ? "Upload once" : "Upload",
      ...(outside
        ? {
            note:
              files.length === 1
                ? "This file is outside the folders Arden can use."
                : "Some of these files are outside the folders Arden can use."
          }
        : {})
    },
    data: { ...data, ...(grant === undefined ? {} : grantData(grant)) }
  }
}

const stageFiles = async (
  files: ReadonlyArray<ResolvedFile>
): Promise<{ readonly paths: Array<string>; readonly cleanup: () => Promise<void> }> => {
  const folders: Array<string> = []
  const cleanup = async () => {
    await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })))
  }
  try {
    const paths: Array<string> = []
    for (const file of files) {
      const folder = await mkdtemp(path.join(tmpdir(), "arden-upload-"))
      folders.push(folder)
      const target = path.join(folder, file.filename)
      await writeFile(target, file.bytes, { mode: 0o600 })
      paths.push(target)
    }
    return { paths, cleanup }
  } catch (cause) {
    await cleanup()
    throw cause
  }
}

export const browserUploadTools = Effect.gen(function* () {
  return [makeBrowserUploadTool({ ...(yield* sharedFileServices), browser: yield* BrowserClient })]
})
