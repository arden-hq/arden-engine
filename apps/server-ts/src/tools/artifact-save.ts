import { ToolExecutionError } from "@arden-hq/loop"
import { PermissionRules } from "../persistence/permissions/rules.js"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { DataRoot } from "../runtime/data-root.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { ConversationArtifacts } from "../artifacts/conversation.js"
import { sessionLineage } from "../persistence/sessions/lineage.js"
import {
  policyPathOptions,
  resolveLocalPath,
  sessionPathPolicy,
  type LocalPathServices
} from "../storage/local-paths.js"
import { recordApplied } from "../execution/tool-effect.js"
import { appliedReceipt } from "./call-receipt.js"
import { fileMediaTypeForName } from "./shared-file-sources.js"
import { toolFailure } from "./tool-failure.js"

const ParametersSchema = Schema.Struct({
  path: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)).annotate({
      description: "Existing file to save. Relative paths use the current Local folder."
    })
  ),
  content: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(8 * 1024 * 1024)).annotate({
      description:
        "Generated UTF-8 text when no source file exists. Use path for larger or binary artifacts."
    })
  ),
  filename: Schema.optionalKey(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(255),
      Schema.isPattern(/^[^/\\]+$/)
    ).annotate({
      description: "Filename, including extension, required with content and omitted with path."
    })
  ),
  operation_key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).annotate({
    description:
      "Stable producer operation name. Reuse it only when replaying the same logical output."
  }),
  title: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
    description: "Short human-readable artifact title."
  }),
  summary: Schema.Trimmed.check(Schema.isMaxLength(500))
    .annotate({
      description: "Optional concise description of the artifact."
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed("")))
}).check(
  Schema.makeFilter((input) => {
    if ((input.path === undefined) === (input.content === undefined)) {
      return { path: [], issue: "provide exactly one of path or content" }
    }
    if (input.content !== undefined && input.filename === undefined) {
      return { path: ["filename"], issue: "is required with content" }
    }
    if (input.path !== undefined && input.filename !== undefined) {
      return { path: ["filename"], issue: "must be omitted with path" }
    }
  })
)

const makeArtifactSaveTool = (
  services: LocalPathServices & { readonly artifacts: ConversationArtifacts["Service"] }
): ServerTool =>
  defineServerTool({
    name: "artifact_save",
    description: [
      "Save a generated file as a durable task artifact and return its path.",
      "Use this for substantial JSON, CSV, reports, and other reusable outputs instead of placing their contents in agent messages.",
      "Prefer an existing path; research agents without file-write access may provide UTF-8 content and a filename directly.",
      "Send other agents only a short summary plus the returned path and artifact_ref.",
      "The root task owns the artifact; child agents and workflow nodes share it. A stable operation_key makes retries idempotent."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ParametersSchema),
    metadata: {
      display: { result: "saved_artifact" },
      effect: "arden_db",
      scopes: ["agent_research"],
      display_name: "Save artifact",
      kind: "filesystem",
      action: "write",
      approval_preview: "Save a generated file as a task artifact.",
      source: "_filesystem",
      changes_state: true,
      target: "reported",
      concurrency_group: "conversation_artifacts",
      destructive: false,
      default_approval: "approve",
      idempotent: true,
      background: true
    },
    execute: async (input, ctx, effects) => {
      const policy = await sessionPathPolicy(services, {
        sessionId: ctx.run.sessionId,
        runId: ctx.run.runId,
        signal: ctx.signal
      })
      const source =
        input.path === undefined
          ? {
              kind: "bytes" as const,
              bytes: Buffer.from(input.content ?? "", "utf8"),
              filename: input.filename ?? "artifact.txt"
            }
          : {
              kind: "path" as const,
              path: await resolveLocalPath(input.path, policy.cwd, policyPathOptions(policy))
            }
      const lineage = await Effect.runPromise(
        sessionLineage(services.sessions, ctx.run.sessionId),
        {
          signal: ctx.signal
        }
      )
      const ownerSessionId = lineage.at(-1)?.sessionId
      if (ownerSessionId === undefined) {
        throw new ToolExecutionError("The artifact owner could not be resolved", {
          preview: "Artifact owner unavailable",
          retryable: true
        })
      }
      const manifest = await recordApplied(
        effects,
        Effect.runPromise(
          services.artifacts
            .createFile({
              sessionId: ownerSessionId,
              producerRunId: ctx.run.runId,
              operationKey: input.operation_key,
              source,
              title: input.title,
              summary: input.summary,
              mediaType: fileMediaTypeForName(
                source.kind === "path" ? source.path : source.filename
              ),
              role: "output"
            })
            .pipe(Effect.mapError((error) => toolFailure(error, "Artifact could not be saved"))),
          { signal: ctx.signal }
        )
      )
      const artifactPath = await Effect.runPromise(
        services.artifacts.path(ownerSessionId, manifest.ref),
        { signal: ctx.signal }
      )
      return {
        result: `Saved ${manifest.ref}. Refer to ${artifactPath}; do not copy its contents into messages.`,
        preview: `Saved ${manifest.title}`,
        data: {
          artifact_ref: manifest.ref,
          path: artifactPath,
          producer_run_id: ctx.run.runId,
          operation_key: input.operation_key,
          sha256: manifest.sha256,
          byte_length: manifest.byte_length,
          media_type: manifest.media_type
        },
        host: appliedReceipt(ctx, {
          kind: "versioned_resource",
          resourceRef: `output:${manifest.ref}`,
          beforeVersion: "absent",
          afterVersion: manifest.sha256,
          domain: "file",
          title: manifest.title
        })
      }
    }
  })

export const artifactSaveTools = Effect.gen(function* () {
  return [
    makeArtifactSaveTool({
      artifacts: yield* ConversationArtifacts,
      sessions: yield* SessionQueries,
      spaces: yield* SpaceStore,
      runs: yield* RunQueries,
      rules: yield* PermissionRules,
      dataDir: (yield* DataRoot).dir
    })
  ]
})
