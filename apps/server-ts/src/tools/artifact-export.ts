import { ToolExecutionError } from "@arden-hq/loop"
import { PermissionRules } from "../persistence/permissions/rules.js"
import { Effect, Schema } from "effect"
import { constants } from "node:fs"
import { open } from "node:fs/promises"

import { defineServerTool, type ServerTool } from "./define.js"
import { DataRoot } from "../runtime/data-root.js"
import { toolFailure, toolRefusal } from "./tool-failure.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { sessionLineage } from "../persistence/sessions/lineage.js"
import { ConversationArtifactError } from "../artifacts/conversation-model.js"
import { ConversationArtifacts } from "../artifacts/conversation.js"
import { mutationReceiptHost } from "../persistence/tools/mutation-receipt.js"
import {
  policyPathOptions,
  resolveLocalPath,
  sessionPathPolicy,
  type LocalPathServices
} from "../storage/local-paths.js"
import type { ServerRunContext } from "./run-context.js"
import { sharedResourceSessions } from "../execution/authority.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { publishNoReplace } from "@arden-hq/std/publish"
import { displayLocalPath } from "../storage/local-directory.js"

const ParametersSchema = Schema.Struct({
  artifact_ref: Schema.String.check(Schema.isPattern(/^(?:viz|file)-[a-f0-9]{32}$/)).annotate({
    description:
      "Exact artifact_ref from this task, as returned by artifact_save, browser_screenshot, exec_command or chat_files_list."
  }),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)).annotate({
    description:
      "Destination file, including its extension. Relative paths use the current Local folder. The parent folder must exist. Existing different content is never overwritten."
  })
})

const makeArtifactExportTool = (
  services: LocalPathServices & { readonly artifacts: ConversationArtifacts["Service"] }
): ServerTool => {
  const prepare = async (
    input: typeof ParametersSchema.Type,
    ctx: { readonly run: ServerRunContext; readonly signal: AbortSignal }
  ) => {
    const policy = await sessionPathPolicy(services, {
      sessionId: ctx.run.sessionId,
      runId: ctx.run.runId,
      signal: ctx.signal
    })
    const target = await resolveLocalPath(input.path, policy.cwd, {
      allowMissing: true,
      mutation: true,
      ...policyPathOptions(policy)
    })
    const lineage =
      ctx.run.authority.actor.kind === "agent"
        ? await Effect.runPromise(sessionLineage(services.sessions, ctx.run.sessionId), {
            signal: ctx.signal
          })
        : []
    const rootSessionId = lineage.at(-1)?.sessionId
    const owners = [
      ctx.run.sessionId,
      ...(rootSessionId === undefined ? [] : [rootSessionId]),
      ...sharedResourceSessions(ctx.run.authority, "agent_code").map(
        (resource) => resource.session_id
      )
    ]
    let artifact: import("../artifacts/conversation-model.js").ConversationArtifact | undefined
    let artifactFailure: unknown
    for (const ownerSessionId of new Set(owners)) {
      try {
        artifact = await Effect.runPromise(
          services.artifacts.read(ownerSessionId, input.artifact_ref),
          { signal: ctx.signal }
        )
        break
      } catch (cause) {
        artifactFailure = cause
        if (!(cause instanceof ConversationArtifactError))
          throw toolRefusal("The artifact could not be read", "Artifact unavailable")
        if (cause.reason !== "not_found") throw toolFailure(cause, "Artifact unavailable")
      }
    }
    if (artifact === undefined) {
      throw toolRefusal(
        artifactFailure instanceof ConversationArtifactError
          ? artifactFailure.message
          : "The artifact is not available in this Chat or a granted shared Session",
        "Artifact unavailable"
      )
    }
    return { target, artifact, displayPath: displayLocalPath(target, policy.cwd) }
  }

  return defineServerTool({
    name: "artifact_export",
    summary: "Copies a file Arden saved into a file on your Mac.",
    discovery: { group: "output" },
    description: [
      "Copy a saved task artifact into a local file. This is how you read an artifact: export it, then use file_read.",
      "Takes an artifact_ref from artifact_save, browser_screenshot, exec_command or chat_files_list; never transcribe artifact bytes into a message.",
      "Relative paths use the current Local folder. Create the parent folder first. An existing file with the same content succeeds unchanged; different content is never overwritten, so choose another filename.",
      "May need the user's approval. Returns the absolute path, media type, byte length, and SHA-256."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ParametersSchema),
    metadata: {
      effect: "local_files",
      display_name: "Export artifact",
      kind: "filesystem",
      action: "write",
      approval_preview: "Copy a saved artifact into a local file.",
      source: "_filesystem",
      changes_state: true,
      target: "reported",
      concurrency_group: "filesystem",
      destructive: false,
      default_approval: "ask",
      idempotent: true,
      background: true
    },
    approvalPrompt: async (input, ctx) => {
      const { target, artifact, displayPath } = await prepare(input, ctx)
      return {
        preview: `Export ${artifact.manifest.media_type} to ${displayPath} (${artifact.bytes.byteLength} bytes)`,
        data: { path: target, artifact_ref: input.artifact_ref, sha256: artifact.manifest.sha256 }
      }
    },
    execute: async (input, ctx) => {
      const { target, artifact, displayPath } = await prepare(input, ctx)
      const approved = ctx.approval?.data
      if (
        approved !== undefined &&
        (approved.path !== target ||
          approved.artifact_ref !== input.artifact_ref ||
          approved.sha256 !== artifact.manifest.sha256)
      ) {
        throw new ToolExecutionError("The approved artifact or export target changed", {
          preview: "Approval mismatch"
        })
      }
      const outcome = await publishArtifact({
        target,
        bytes: artifact.bytes,
        sha256: artifact.manifest.sha256
      })
      return {
        result: `Exported ${input.artifact_ref} to ${target} (${artifact.bytes.byteLength} bytes).`,
        preview: outcome === "no_op" ? "Already exported" : `Exported ${displayPath}`,
        data: {
          artifact_ref: input.artifact_ref,
          path: displayPath,
          absolute_path: target,
          media_type: artifact.manifest.media_type,
          byte_length: artifact.bytes.byteLength,
          sha256: artifact.manifest.sha256,
          ...(artifact.manifest.capture === undefined ? {} : { capture: artifact.manifest.capture })
        },
        host: mutationReceiptHost({
          identity: { runId: ctx.run.runId, toolCallId: ctx.toolCallId },
          outcome,
          resource: {
            kind: "file_revision",
            absolutePath: target,
            beforeVersion: outcome === "no_op" ? artifact.manifest.sha256 : "absent",
            afterVersion: artifact.manifest.sha256
          }
        })
      }
    }
  })
}

const publishArtifact = async (input: {
  readonly target: string
  readonly bytes: Uint8Array
  readonly sha256: string
}): Promise<"applied" | "no_op"> => {
  try {
    if (await publishNoReplace(input.target, input.bytes)) return "applied"
    const existing = await open(
      input.target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const status = await existing.stat()
      if (
        status.isFile() &&
        status.size === input.bytes.byteLength &&
        sha256Hex(await existing.readFile()) === input.sha256
      )
        return "no_op"
    } finally {
      await existing.close()
    }
    throw new ToolExecutionError(
      "Export destination already contains different content. Choose another filename.",
      {
        preview: "File already exists"
      }
    )
  } catch (cause) {
    if (cause instanceof ToolExecutionError) throw cause
    throw new ToolExecutionError(`Could not export artifact to ${input.target}`, {
      preview: "Export failed",
      retryable: true
    })
  }
}

export const artifactExportTools = Effect.gen(function* () {
  return [
    makeArtifactExportTool({
      artifacts: yield* ConversationArtifacts,
      sessions: yield* SessionQueries,
      spaces: yield* SpaceStore,
      runs: yield* RunQueries,
      rules: yield* PermissionRules,
      dataDir: (yield* DataRoot).dir
    })
  ]
})
