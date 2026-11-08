import { DECISION_WORD } from "@arden-hq/protocol/permissions"
import { isWithin } from "@arden-hq/std/paths"
import { PermissionRules } from "../persistence/permissions/rules.js"
import { ToolExecutionError, type ToolApprovalContext, type ToolResult } from "@arden-hq/loop"
import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import { AgentModeSchema, PersistedChildAgentMetadataSchema } from "@arden-hq/protocol/effect/chat"
import { Effect, Schema } from "effect"

import {
  defineServerTool,
  type ServerApprovalPrompt,
  type ServerTool,
  type ServerToolMetadataInput
} from "./define.js"
import { waivesRequirement } from "../execution/decide.js"
import { DataRoot } from "../runtime/data-root.js"
import { ConversationArtifacts } from "../artifacts/conversation.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import type { LocalPathServices } from "../storage/local-paths.js"
import { JsonObjectSchema } from "../persistence/json.js"
import { ModelProviderService } from "../models/provider.js"
import { outputSchemaProblem } from "../models/structured-output.js"
import { ModelCatalog } from "../models/catalog.js"
import { resolveLocalDirectory, sessionPathPolicy } from "../storage/local-paths.js"
import type { CodeAgentWorkspace } from "../sessions/agent-mode.js"
import { folderGrantFor, grantData, type FolderGrant } from "./folder-grant.js"
import type { ServerRunContext } from "./run-context.js"
import { SPAWN_AGENT_TOOL } from "../persistence/tools/tool-roles.js"

const ParametersSchema = Schema.Struct({
  output_schema: Schema.optionalKey(
    JsonObjectSchema.annotate({
      description:
        "JSON Schema for the child's final answer. Set when code or another agent must consume JSON fields; uses native structured output. Omit for a prose answer; never rely on reply text merely prompted to look like JSON."
    })
  ),
  task_item_id: Schema.optionalKey(
    Schema.NonEmptyString.annotate({
      description:
        "Optional existing Task item_id to attach this attempt. Omit for one-off work; a worker does not require a Task."
    })
  ),
  name: Schema.optionalKey(
    Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(80)).annotate({
      description: "A concise 3-7 word display name for this child agent's work."
    })
  ),
  task: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).annotate({
    description:
      "The child's complete brief, up to 20,000 characters. A fresh child sees only this, so put the whole brief here rather than pointing it at another chat."
  }),
  model: Schema.optionalKey(
    Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
      description:
        "Optional exact model id from model_catalog for a fresh child. Omit to inherit the parent model; a forked child always inherits it."
    })
  ),
  reasoning_effort: Schema.optionalKey(
    Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(128)).annotate({
      description: "Optional reasoning effort for the selected model. Requires model."
    })
  ),
  fork_context: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "true starts the child from this conversation so far, so it already knows what you know and the task only says what to do next; it is cheap because the child reuses this conversation's cache. Omit for a fresh child that sees only its task."
    })
  ),
  mode: AgentModeSchema.annotate({
    description:
      "research is read-only; code writes and tests code in one Local folder (reads the machine except secrets, writes only there, no network or host access without approval); work performs other authorized one-off actions with inherited permissions."
  }),
  working_directory: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
      description: [
        "Optional starting directory for a code agent.",
        "Defaults to the Space's Default folder.",
        "A directory outside the Space's attached folders asks for approval unless this run uses Never ask."
      ].join(" ")
    })
  )
}).check(
  Schema.makeFilter((input) => {
    if (input.mode !== "code" && input.working_directory !== undefined) {
      return { path: ["working_directory"], issue: "is available only when mode is code" }
    }
    if (input.reasoning_effort !== undefined && input.model === undefined) {
      return { path: ["reasoning_effort"], issue: "requires model" }
    }
    if (input.fork_context === true && input.model !== undefined) {
      return {
        path: ["model"],
        issue: "is not allowed with fork_context; a forked child inherits the parent model"
      }
    }
  })
)

const ResultSchema = Schema.Struct({
  content: Schema.String,
  preview: Schema.String,
  data: Schema.StructWithRest(Schema.Struct({ child_agent: PersistedChildAgentMetadataSchema }), [
    JsonObjectSchema
  ])
})

type SpawnAgentInput = (typeof ParametersSchema)["Type"]

interface ResolvedWorkspace {
  readonly workspace: CodeAgentWorkspace
  readonly expandsAccess: boolean
  readonly grant: FolderGrant | undefined
}

export const spawnFailure = (cause: unknown): ToolExecutionError => {
  if (cause instanceof ToolExecutionError) {
    return new ToolExecutionError(cause.message, {
      preview: cause.preview ?? "Agent was not started",
      retryable: cause.retryable === true
    })
  }
  return new ToolExecutionError("The agent Session could not be started", {
    preview: "Agent was not started",
    retryable: true
  })
}

const validateRequestedModel = async (
  models: Pick<ModelCatalog["Service"], "catalog">,
  input: SpawnAgentInput,
  signal: AbortSignal
): Promise<void> => {
  if (input.model === undefined) return
  const catalog = await Effect.runPromise(models.catalog(), { signal }).catch((cause: unknown) => {
    if (signal.aborted) throw cause
    throw new ToolExecutionError(
      "Could not check available models. Omit model to inherit the current run's model.",
      {
        preview: "Model catalog unavailable",
        retryable: true
      }
    )
  })
  const definition = catalog.providers
    .flatMap((provider) => provider.models)
    .find((model) => model.id === input.model)
  if (definition === undefined) {
    throw new ToolExecutionError(
      `${input.model} is not in Arden's current model catalog. Call model_catalog for exact available IDs, or omit model to inherit.`,
      { preview: "Agent model unavailable", retryable: false }
    )
  }
  if (
    input.reasoning_effort !== undefined &&
    !definition.reasoningEfforts.includes(input.reasoning_effort)
  ) {
    throw new ToolExecutionError(
      `${input.model} does not support ${input.reasoning_effort} reasoning. Supported: ${definition.reasoningEfforts.join(", ") || "none"}.`,
      { preview: "Agent reasoning unavailable", retryable: false }
    )
  }
}

const resolveWorkspace = async (
  services: LocalPathServices,
  input: SpawnAgentInput,
  ctx: { readonly run: ServerRunContext; readonly signal: AbortSignal }
): Promise<ResolvedWorkspace | null> => {
  if (input.mode !== "code") return null
  const context = { sessionId: ctx.run.sessionId, runId: ctx.run.runId, signal: ctx.signal }
  const policy = await sessionPathPolicy(services, context)
  if (input.working_directory === undefined)
    throw new ToolExecutionError("A code agent needs working_directory: the folder it works in.", {
      preview: "Folder required",
      retryable: false
    })
  const requested = await resolveLocalDirectory(
    input.working_directory,
    policy.cwd,
    policy.stateRoot,
    policy.pathRules
  )
  const attachedRoot = policy.localRoots.reduce<string | null>((selected, root) => {
    if (!isWithin(root, requested)) return selected
    return selected === null || isWithin(selected, root) ? root : selected
  }, null)
  if (attachedRoot !== null) {
    return {
      workspace: { root: attachedRoot, cwd: requested },
      expandsAccess: false,
      grant: undefined
    }
  }
  return {
    workspace: { root: requested, cwd: requested },
    expandsAccess: true,
    grant: await folderGrantFor(services, ctx, requested)
  }
}

const approvalPrompt = (resolved: ResolvedWorkspace): ServerApprovalPrompt => ({
  preview: `${DECISION_WORD.allow} code-agent access to ${resolved.workspace.root}?`,
  presentation: {
    title: "Allow this Local folder?",
    fields: [
      { label: "Local folder", value: resolved.workspace.root },
      ...(resolved.workspace.cwd === resolved.workspace.root
        ? []
        : [{ label: "Starts in", value: resolved.workspace.cwd }])
    ],
    body: {
      label: "Access",
      text: "This child can read and write inside the Local folder for this task."
    }
  },
  data: {
    sandbox_root: resolved.workspace.root,
    working_directory: resolved.workspace.cwd,
    ...(resolved.grant === undefined ? {} : grantData(resolved.grant))
  }
})

const approvedWorkspace = (
  approval: ToolApprovalContext | undefined
): CodeAgentWorkspace | null => {
  const data = approval?.data
  if (data === undefined) return null
  const root = data["sandbox_root"]
  const cwd = data["working_directory"]
  return typeof root === "string" && typeof cwd === "string" ? { root, cwd } : null
}

const verifyApproval = (
  resolved: ResolvedWorkspace,
  approval: ToolApprovalContext | undefined,
  approvalMode: ChatApprovalMode
): void => {
  if (approval === undefined) {
    if (resolved.expandsAccess && !waivesRequirement(approvalMode, SPAWN_METADATA)) {
      throw new ToolExecutionError("This Local folder requires user approval.", {
        preview: "Local folder approval required",
        retryable: false
      })
    }
    return
  }
  const approved = approvedWorkspace(approval)
  if (
    approved === null ||
    approved.root !== resolved.workspace.root ||
    approved.cwd !== resolved.workspace.cwd
  ) {
    throw new ToolExecutionError(
      "The Local folder changed after it was approved. Request approval again.",
      { preview: "Local folder changed", retryable: false }
    )
  }
}

const decodeResult = async (raw: ToolResult): Promise<(typeof ResultSchema)["Type"]> =>
  Effect.runPromise(
    Schema.decodeUnknownEffect(ResultSchema)(raw, {
      onExcessProperty: "error"
    }).pipe(
      Effect.mapError(
        () =>
          new ToolExecutionError("The agent Session returned an invalid reference", {
            preview: "Agent was not started",
            retryable: false
          })
      )
    )
  )

const SPAWN_METADATA = {
  effect: "arden_db",
  detached: true,
  scopes: ["agent_research", "agent_code"],
  code_mode: false,
  display_name: "Spawn Agent",
  kind: "agent",
  action: "execute",
  approval_preview: "Start a separate agent for this part of the work.",
  source: "_agents",
  changes_state: true,
  target: "reported",
  concurrency_group: "agent_spawn",
  destructive: false,
  approval_bypass: true
} satisfies ServerToolMetadataInput

const makeSpawnAgentTool = (
  services: LocalPathServices & {
    readonly models: Pick<ModelCatalog["Service"], "catalog">
    readonly provider: ModelProviderService["Service"]
  }
): ServerTool =>
  defineServerTool({
    name: SPAWN_AGENT_TOOL,
    description: [
      "Start an independent child agent for one task: research for evidence-only work, code to write and test code in a Local folder, or work for other authorized actions.",
      "Research and code parents can spawn children only in their own mode, within the configured depth limit and inherited permissions.",
      "Returns immediately with the child's reference for agent_message; its completion is delivered here automatically at a model-step boundary while you work, or starts a continuation if you are idle.",
      "Do not claim its findings before that notification arrives."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ParametersSchema),
    metadata: SPAWN_METADATA,
    approvalRequirement: async (input, ctx) => {
      await validateRequestedModel(services.models, input, ctx.signal)
      const resolved = await resolveWorkspace(services, input, ctx)
      return resolved?.expandsAccess === true ? approvalPrompt(resolved) : undefined
    },
    approvalPrompt: async (input, ctx) => {
      const resolved = await resolveWorkspace(services, input, ctx)
      return resolved === null
        ? { preview: input.mode === "work" ? "Start this worker?" : "Start this research agent?" }
        : approvalPrompt(resolved)
    },
    execute: async (input, ctx) => {
      if (input.output_schema !== undefined) {
        const route = services.provider.current()
        const problem =
          route === undefined
            ? "No model provider is available for structured output"
            : outputSchemaProblem(input.output_schema, route.structuredOutputDialect)
        if (problem !== undefined)
          throw new ToolExecutionError(problem, {
            preview: "Agent output schema unsupported",
            retryable: false
          })
      }
      await validateRequestedModel(services.models, input, ctx.signal)
      const resolved = await resolveWorkspace(services, input, ctx)
      if (resolved !== null) verifyApproval(resolved, ctx.approval, ctx.run.approvalMode)
      let raw: ToolResult
      try {
        if (input.mode !== "code") {
          raw = await ctx.run.spawnAgent({
            toolCallId: ctx.toolCallId,
            arguments: input,
            task: input.task,
            ...(input.output_schema === undefined ? {} : { outputSchema: input.output_schema }),
            ...(input.task_item_id === undefined ? {} : { taskItemId: input.task_item_id }),
            mode: input.mode,
            ...(input.fork_context === true ? { forkHistory: ctx.messages } : {}),
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.reasoning_effort === undefined
              ? {}
              : { reasoningEffort: input.reasoning_effort }),
            ...(input.name === undefined ? {} : { name: input.name })
          })
        } else {
          if (resolved === null) throw new Error("Code-agent workspace was not resolved")
          raw = await ctx.run.spawnAgent({
            toolCallId: ctx.toolCallId,
            arguments: input,
            task: input.task,
            ...(input.output_schema === undefined ? {} : { outputSchema: input.output_schema }),
            ...(input.task_item_id === undefined ? {} : { taskItemId: input.task_item_id }),
            mode: "code",
            ...(input.fork_context === true ? { forkHistory: ctx.messages } : {}),
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.reasoning_effort === undefined
              ? {}
              : { reasoningEffort: input.reasoning_effort }),
            workspace: resolved.workspace,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.working_directory === undefined
              ? {}
              : { requestedWorkingDirectory: input.working_directory })
          })
        }
      } catch (cause) {
        throw spawnFailure(cause)
      }
      const { host, ...spawned } = raw
      const decoded = await decodeResult(spawned)
      return {
        result: decoded.content,
        preview: decoded.preview,
        data: decoded.data,
        ...(host === undefined ? {} : { host })
      }
    }
  })

export const spawnAgentTools = Effect.gen(function* () {
  return [
    makeSpawnAgentTool({
      sessions: yield* SessionQueries,
      spaces: yield* SpaceStore,
      runs: yield* RunQueries,
      artifacts: yield* ConversationArtifacts,
      models: yield* ModelCatalog,
      provider: yield* ModelProviderService,
      rules: yield* PermissionRules,
      dataDir: (yield* DataRoot).dir
    })
  ]
})
