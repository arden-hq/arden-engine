import { scopedRunToolNames, scopedToolNames } from "./tool-scopes.js"
import { makeReviewPlans } from "./review-plans.js"
import type { ToolScopeKey } from "../execution/policy.js"
import type { ServerTool, ServerToolMetadata } from "./define.js"
import { makeToolApprovalPolicy, reachOf, toolRule } from "./approval-policy.js"
import { ApprovalPolicyStore } from "../persistence/permissions/approval-policy.js"
import { internalStateTools } from "./internal-state.js"
import { ModelStore } from "../persistence/models/store.js"
import { ModelCatalog } from "../models/catalog.js"
import { createToolset, ToolExecutionError, type Toolset } from "@arden-hq/loop"
import type { ToolCatalogEntry, ToolCatalogResponse, ToolPolicy } from "@arden-hq/protocol/tools"
import type { NewPermissionRule } from "@arden-hq/protocol/permissions"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { TranscriptQueries } from "../persistence/transcript/queries.js"
import { canonicalRulePath } from "../fs/protected-paths.js"
import { compileWords, type CompiledWords } from "./rule-compile.js"
import {
  PermissionRules,
  PermissionRulesError,
  wordsRuleText,
  type RuleSubject
} from "../persistence/permissions/rules.js"
import { TOOL_SUMMARIES } from "./tool-summaries.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { AutomationCatalog } from "../persistence/automations/catalog.js"
import { capabilityTools } from "./capability.js"
import { computerTools } from "./computer.js"
import { codeModeTools } from "./code-mode.js"
import { unlistedToolDisplay } from "./display.js"
import { applyToolCatalog, ownedToolNames, refusalText, treeToolNames } from "./tool-catalog.js"
import { ModelProviderService } from "../models/provider.js"
import { meteredModelCall } from "../models/call-usage.js"
import { UsageStore } from "../persistence/usage/store.js"
import { StructuredCompletion } from "../models/structured-completion.js"
import { TOOL_DISPLAY_TITLE } from "../execution/tool-call-presentation.js"
import { authorityScopes } from "../execution/authority.js"
import { makeApprovalGate } from "./approval-gate.js"
import { makePermissionOffers } from "./permission-offer.js"
import { namedCommandGrant } from "./shell-policy.js"
import { readCommandViews, readJobShell } from "../execution/rules.js"
import { WorkStore } from "../persistence/work/store.js"
import { makeApprovalReview } from "./approval-review.js"
import { approvalReviewAuthority } from "./approval-review-authority.js"
import { sessionSearchTools } from "./session-search.js"
import { chatSummaryTools } from "./chat-summary.js"
import { skillTools } from "./skill.js"
import { timeTools } from "./time.js"
import { onboardingTools } from "./onboarding.js"
import { modelCatalogTools } from "./model-catalog.js"
import { wikiTools } from "./wiki.js"
import { workTools } from "./work.js"
import { taskTools } from "./task-tools.js"
import { taskContractTools } from "./task-contract-tools.js"
import { workOutputTools } from "./work-output.js"
import { workFollowTools } from "./work-follow.js"
import { taskInferenceTools } from "./task-inference.js"
import { connectionItemTools } from "./connection-items.js"
import { spaceControlTools } from "./space-controls.js"
import { spaceArchiveTools } from "./space-archive.js"
import { shellTools } from "./exec-command.js"
import { fileTools } from "./files.js"
import { webFetchTools } from "./web-fetch.js"
import { webSearchTools } from "./web-search.js"
import type { ScriptAgentExecutionProfile, ScriptHost } from "../workflows/runtime/contract.js"
import type { ServerToolRun } from "../chat/runner-contract.js"
import { WorkflowHost } from "../workflows/host.js"
import {
  makeBrowserObservationRegistry,
  makeObservationRegistry,
  type ServerRunContext
} from "./run-context.js"
import { liveToolset } from "./live-toolset.js"
import { mcpToolProvider } from "../mcp/provider.js"
import { parseMcpSource } from "../mcp/naming.js"
import { PermissionStore } from "../persistence/permissions/store.js"
import { McpStore } from "../persistence/mcp/store.js"
import { mcpServiceTitle } from "../mcp/transport.js"
import { DeferredToolCalls } from "../persistence/tools/deferred.js"
import { JsonObjectSchema } from "../persistence/json.js"
import { sanitizeApprovalPresentation } from "@arden-hq/protocol/chat"
import { browserPointerTools } from "./browser-pointer.js"
import { browserTools } from "./browser.js"
import { browserProcedureTools } from "./browser-procedure.js"
import { BrowserProcedureStore } from "../persistence/browser-procedures/store.js"
import { validateProcedureCall } from "../browser/procedures/guards.js"
import { browserTaskTools } from "./browser-task.js"
import { browserUploadTools } from "./browser-upload.js"
import { chatFilesTools } from "./chat-files.js"
import { browserPermissionTools } from "./browser-permission.js"
import { browserAskSecretTools } from "./browser-ask-secret.js"
import { artifactDeleteTools } from "./artifact-delete.js"
import { artifactExportTools } from "./artifact-export.js"
import { artifactSaveTools } from "./artifact-save.js"
import { sessionTools } from "./sessions.js"
import { answerBlockTools } from "./answer-block-read.js"
import { sessionActionTools } from "./session-actions.js"
import { automationTools } from "./automations.js"
import { automationFollowupTools } from "./automation-followup.js"
import { automationRunEventsTools } from "./automation-run-events.js"
import { spaceReviewFinishTools } from "./space-review-finish.js"
import { spaceTools } from "./spaces.js"
import { wikiReportTools } from "./wiki-reports.js"
import { wikiCollectionsTools } from "./wiki-collections.js"
import { wikiOperationTools } from "./wiki-operations.js"
import { wikiChangeTools } from "./wiki-change.js"
import { todoTools } from "./todos.js"
import { googleToolProvider } from "./google-provider.js"
import { directivesTools } from "./directives.js"
import { spawnAgentTools } from "./spawn-agent.js"
import { agentMessageTools } from "./agent-message.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { workflowTools } from "./workflows.js"
import { skillGuard } from "../skills/guard.js"
import { withMiddleware } from "../execution/toolset-middleware.js"
import { localizeOutputs } from "./localize-outputs.js"
import { makeCodeModeHost } from "./code-mode-host.js"
import { makeWorkflowNodeRunner } from "./workflow-node-runner.js"
import { workflowHash } from "../workflows/identity.js"
import { ResearchWorkspace } from "../research/workspace.js"
import { captureResearchSources, researchEvidenceTools } from "./research-evidence.js"
import { ManagedOutputs } from "../artifacts/managed-output/managed-output.js"
import { reportTools } from "./report.js"
import { tellTools } from "./tell.js"
import { toolParametersJsonSchema } from "./tool-json-schema.js"
import { ROLE_TOOLS } from "../persistence/tools/tool-roles.js"
import type { ApprovalAlternativeInput, ApprovalEditsInput } from "../persistence/tools/store.js"

const builtinTools = Effect.all([
  internalStateTools,
  todoTools,
  directivesTools,
  sessionSearchTools,
  chatSummaryTools,
  capabilityTools,
  codeModeTools,
  computerTools,
  workflowTools,
  sessionTools,
  sessionActionTools,
  answerBlockTools,
  automationTools,
  automationFollowupTools,
  automationRunEventsTools,
  reportTools,
  tellTools,
  spaceReviewFinishTools,
  timeTools,
  modelCatalogTools,
  shellTools,
  fileTools,
  webSearchTools,
  webFetchTools,
  browserTools,
  browserTaskTools,
  browserProcedureTools,
  browserPointerTools,
  browserUploadTools,
  chatFilesTools,
  browserPermissionTools,
  browserAskSecretTools,
  artifactExportTools,
  artifactSaveTools,
  artifactDeleteTools,
  spawnAgentTools,
  agentMessageTools,
  skillTools,
  wikiTools,
  wikiOperationTools,
  wikiChangeTools,
  wikiCollectionsTools,
  wikiReportTools,
  spaceTools,
  workTools,
  taskTools,
  taskContractTools,
  workOutputTools,
  workFollowTools,
  taskInferenceTools,
  connectionItemTools,
  spaceControlTools,
  spaceArchiveTools,
  researchEvidenceTools,
  onboardingTools
]).pipe(Effect.map((groups): ReadonlyArray<ServerTool> => groups.flat()))

const toolProviders = Effect.all([googleToolProvider, mcpToolProvider])

const policy = (metadata: ServerToolMetadata): ToolPolicy => ({
  action: metadata.action,
  scope: metadata.policy_scope,
  requiresApproval: metadata.default_approval === "ask",
  permissions: metadata.permissions,
  concurrencyGroup: metadata.concurrency_group,
  destructive: metadata.destructive,
  openWorld: metadata.open_world,
  idempotent: metadata.idempotent
})

const catalogEntry = (tool: ServerTool, description: string): ToolCatalogEntry => {
  const metadata = tool.meta
  return {
    name: tool.definition.name,
    displayName: metadata.display_name,
    description,
    kind: metadata.kind,
    source: metadata.source,
    effectivePolicy: policy(metadata),
    defaultApproval: metadata.default_approval,
    display: metadata.display ?? {}
  }
}

export interface RuleNames {
  readonly tool: (
    name: string
  ) => { readonly title: string; readonly server: string | null } | undefined
  readonly connector: (server: string) => string | undefined
}

const toolTitle = (tool: ServerTool, server: string | null): string => {
  const name = tool.meta.display_name
  const suffix = server === null ? "" : ` (${server})`
  return suffix !== "" && name.endsWith(suffix)
    ? name.slice(0, -suffix.length).replace(/[_-]+/gu, " ").trim()
    : name
}

export interface ScopedToolsetOptions {
  readonly intersectScopes?: ReadonlyArray<ToolScopeKey>
  readonly omitSkills?: ReadonlyArray<string>
  readonly declareTree?: boolean
  readonly shellByRules?: boolean
}

const byToolName = (left: { readonly name: string }, right: { readonly name: string }): number => {
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
}

const workflowModeTools = (tools: ReadonlyArray<ServerTool>, scope: ReadonlySet<string>) =>
  tools
    .filter((tool) => scope.has(tool.definition.name))
    .map((tool) => {
      const metadata = tool.meta
      const entry = tool.entry(toolParametersJsonSchema)
      return {
        name: entry.meta.name,
        description: entry.description,
        parameters: Schema.decodeUnknownSync(Schema.Json)(entry.parameters),
        action: metadata.action,
        source: metadata.source,
        changes_state: metadata.changes_state,
        destructive: metadata.destructive,
        open_world: metadata.open_world,
        idempotent: metadata.idempotent
      }
    })
    .sort(byToolName)

const makeExecutionProfile = (builtins: ReadonlyArray<ServerTool>) => {
  const builtinScopes = scopedToolNames(builtins)
  const builtin = {
    research: workflowModeTools(builtins, builtinScopes.agent_research),
    code: workflowModeTools(builtins, builtinScopes.agent_code)
  }
  let last: { readonly key: string; readonly profile: ScriptAgentExecutionProfile } | undefined
  return (runTools: ReadonlyArray<ServerTool>): ScriptAgentExecutionProfile => {
    const scopes = scopedToolNames(runTools)
    const extra = {
      research: workflowModeTools(runTools, scopes.agent_research),
      code: workflowModeTools(runTools, scopes.agent_code)
    }
    const key = JSON.stringify(extra)
    if (last?.key === key) return last.profile
    const research = [...builtin.research, ...extra.research].sort(byToolName)
    const code = [...builtin.code, ...extra.code].sort(byToolName)
    const descriptor = {
      version: 1,
      modes: { research, code }
    }
    const profile = {
      hash: workflowHash(descriptor),
      modes: {
        research: { changesState: research.some((tool) => tool.changes_state) },
        code: { changesState: code.some((tool) => tool.changes_state) }
      }
    }
    last = { key, profile }
    return profile
  }
}

export class ServerToolRegistry extends Context.Service<
  ServerToolRegistry,
  {
    readonly catalog: () => Effect.Effect<ToolCatalogResponse>
    readonly ruleNames: () => Effect.Effect<RuleNames, PermissionRulesError>
    readonly settingsRuleSubjects: (
      subject: NewPermissionRule["subject"]
    ) => Effect.Effect<ReadonlyArray<RuleSubject>, PermissionRulesError>
    readonly compileWords: (input: {
      readonly text: string
      readonly sessionId: string | null
    }) => Effect.Effect<CompiledWords, PermissionRulesError>
    readonly runToolset: (
      run: ServerToolRun,
      options?: Pick<ScopedToolsetOptions, "omitSkills" | "declareTree">
    ) => Effect.Effect<Toolset>
    readonly workflowHost: (scope: ToolScopeKey, run: ServerToolRun) => ScriptHost
    readonly ownedTools: (scopes: ReadonlyArray<ToolScopeKey>) => ReadonlyArray<string>
    readonly applyApprovalEdits: ApprovalEditsInput["apply"]
    readonly offersApprovalDraft: ApprovalAlternativeInput["offeredBy"]
  }
>()("@arden-hq/server/tools/ServerToolRegistry") {
  static readonly layer = Layer.effect(
    ServerToolRegistry,
    Effect.gen(function* () {
      const models = yield* ModelStore
      const modelCatalog = yield* ModelCatalog
      const rules = yield* PermissionRules
      const policy = yield* ApprovalPolicyStore
      const transcript = yield* TranscriptQueries
      const runs = yield* RunQueries
      const sessions = yield* SessionQueries
      const automations = yield* AutomationCatalog
      const permissions = yield* PermissionStore
      const deferred = yield* DeferredToolCalls
      const structured = yield* StructuredCompletion
      const work = yield* WorkStore
      const mcpServers = yield* McpStore
      const approvalPolicy = makeToolApprovalPolicy({ policy, rules })
      const offers = makePermissionOffers({
        permissions,
        work,
        live: (run) =>
          Effect.runPromise(approvalPolicy.live({ runId: run.runId, authority: run.authority })),
        modeHolder: (run) => {
          const follows = run.authority.approval.follows
          if (follows.kind !== "chat") return Promise.resolve(undefined)
          return Effect.runPromise(
            Effect.gen(function* () {
              const permission = yield* policy.session(follows.session_id)
              if (permission.kind !== "chat") return undefined
              const session = yield* sessions.loadHistoryHeader(follows.session_id)
              return {
                sessionId: follows.session_id,
                name: session?.name ?? "",
                mode: permission.approval_mode
              }
            })
          )
        },
        commandGrant: async (run, command) => {
          const views = await Effect.runPromise(readCommandViews(rules, run.authority))
          return {
            grant: await namedCommandGrant(views.run, command),
            system: await namedCommandGrant(views.system, command),
            alwaysAsk: views.alwaysAsk
          }
        },
        compileWords: (text, sessionId) => Effect.runPromise(compileFor({ text, sessionId })),
        connectorTitles: () =>
          Effect.runPromise(
            mcpServers
              .list()
              .pipe(
                Effect.map(
                  (servers) =>
                    new Map(servers.map((server) => [server.name, mcpServiceTitle(server)]))
                )
              )
          )
      })
      const modelProvider = yield* ModelProviderService
      const usageStore = yield* UsageStore
      const approvalReview = makeApprovalReview({
        structured,
        endings: (runId) => Effect.runPromise(policy.reviewEndings(runId)),
        record: (record) => Effect.runPromise(policy.recordReview(record)),
        authority: approvalReviewAuthority({ runs, sessions, transcript, automations, work }),
        source: (sessionId) => {
          const reviewer = modelProvider.current()?.approvalReview
          if (reviewer === undefined) return undefined
          return {
            modelId: reviewer.modelId,
            complete: (input) =>
              Effect.runPromise(
                meteredModelCall(
                  usageStore,
                  {
                    kind: "helper_review",
                    owner: { type: "session", sessionId },
                    modelId: reviewer.modelId
                  },
                  (onResponse) =>
                    Effect.tryPromise(async () => {
                      const response = await reviewer.complete(input)
                      onResponse(response)
                      return response
                    })
                ),
                { signal: input.signal }
              )
          }
        }
      })
      const researchWorkspace = yield* ResearchWorkspace
      const outputs = yield* ManagedOutputs

      const procedureStore = yield* BrowserProcedureStore
      const builtins = yield* builtinTools
      const missingRole = ROLE_TOOLS.find(
        (name) => !builtins.some((tool) => tool.definition.name === name)
      )
      if (missingRole !== undefined) {
        return yield* Effect.die(new Error(`Tool role names an unregistered tool: ${missingRole}`))
      }
      const providers = yield* toolProviders
      const executionProfile = makeExecutionProfile(builtins)
      const cardTool = (name: string): ServerTool | undefined =>
        builtins.find((tool) => tool.definition.name === name) ??
        providers
          .flatMap((provider) => provider.catalog())
          .find((tool) => tool.definition.name === name)
      const publicTools = () =>
        [...builtins, ...providers.flatMap((provider) => provider.catalog())].filter(
          (tool) => !tool.meta.internal_catalog
        )

      const catalog = Effect.fn("ServerToolRegistry.catalog")(function* () {
        const [, mcp] = providers
        const external = new Set(mcp.catalog().map((tool) => tool.definition.name))
        const tools = publicTools()
        return {
          tools: tools.map((tool) =>
            catalogEntry(
              tool,
              external.has(tool.definition.name)
                ? tool.definition.description
                : (TOOL_SUMMARIES[tool.definition.name] ?? "")
            )
          ),
          unlisted: unlistedToolDisplay(
            (name) => tools.find((tool) => tool.definition.name === name)?.meta.display
          )
        }
      })

      const serverOf = (tool: ServerTool): string | null =>
        parseMcpSource(tool.meta.source)?.serverName ?? null

      const rulesError = (message: string) => (cause: unknown) =>
        new PermissionRulesError({ operation: "list", reason: "storage", message, cause })

      const ruleNames = Effect.fn("ServerToolRegistry.ruleNames")(function* () {
        const servers = yield* mcpServers
          .list()
          .pipe(Effect.mapError(rulesError("Could not read the connectors")))
        const titles = new Map(servers.map((server) => [server.name, mcpServiceTitle(server)]))
        const tools = new Map(publicTools().map((tool) => [tool.definition.name, tool]))
        return {
          tool: (name) => {
            const tool = tools.get(name)
            if (tool === undefined) return undefined
            const server = serverOf(tool)
            return { title: toolTitle(tool, server), server }
          },
          connector: (server) => titles.get(server)
        } satisfies RuleNames
      })

      const invalid = (message: string) =>
        new PermissionRulesError({ operation: "save", reason: "invalid", message })

      const settingsRuleSubjects = Effect.fn("ServerToolRegistry.settingsRuleSubjects")(function* (
        subject: NewPermissionRule["subject"]
      ): Effect.fn.Return<ReadonlyArray<RuleSubject>, PermissionRulesError> {
        switch (subject.kind) {
          case "tool": {
            const tool = publicTools().find(
              (candidate) => candidate.definition.name === subject.tool
            )
            if (tool === undefined) return yield* invalid(`Unknown tool: ${subject.tool}`)
            if (tool.meta.always_ask === true)
              return yield* invalid("Arden always asks before this")
            return [{ kind: "tool", tool: subject.tool, server: serverOf(tool) }]
          }
          case "connector":
            return [{ kind: "connector", server: subject.server }]
          case "command": {
            const plan = yield* Effect.promise(() =>
              namedCommandGrant({ own: undefined, rules: [] }, subject.command)
            )
            const rules = plan.offer?.rules ?? []
            if (rules.length !== 1)
              return yield* invalid("Arden keeps one lasting rule for one command")
            return rules.map((rule) => ({
              kind: "command" as const,
              executable: rule.executable_path,
              argumentPrefix: rule.argument_prefix
            }))
          }
          case "host_commands":
            return [{ kind: "host_commands" }]
          case "words":
            return [{ kind: "words", text: wordsRuleText(subject.text) }]
          case "path": {
            const kept = yield* Effect.promise(() => canonicalRulePath(subject.path))
            if (kept === undefined) return yield* invalid("Pick a folder by its full path")
            return [{ kind: "path", path: kept, access: subject.access }]
          }
        }
      })

      const compileFor = Effect.fn("ServerToolRegistry.compileWords")(function* ({
        text,
        sessionId
      }: {
        readonly text: string
        readonly sessionId: string | null
      }) {
        const servers = yield* mcpServers
          .list()
          .pipe(Effect.mapError(rulesError("Could not read the connectors")))
        return yield* compileWords({
          text,
          sessionId,
          role: sessionId === null ? "helper" : { chat: sessionId },
          structured,
          tools: publicTools()
            .filter((tool) => tool.meta.always_ask !== true)
            .map((tool) => ({
              name: tool.definition.name,
              title: toolTitle(tool, serverOf(tool))
            })),
          connectors: servers.map((server) => ({
            name: server.name,
            title: mcpServiceTitle(server)
          })),
          subjects: settingsRuleSubjects
        })
      })

      const observedState = (): Pick<
        ServerRunContext,
        "observations" | "browserObservations" | "reviewPlans"
      > => ({
        observations: makeObservationRegistry(),
        browserObservations: makeBrowserObservationRegistry(),
        reviewPlans: makeReviewPlans()
      })

      const bindTools = (
        scope: ToolScopeKey,
        options: ScopedToolsetOptions,
        run: ServerToolRun,
        observed: ReturnType<typeof observedState>
      ): {
        readonly toolset: Toolset
        readonly workflowHost: ScriptHost
      } => {
        const runTools = providers.flatMap((provider) => provider.forRun(run))
        const current = [...builtins, ...runTools]
        const scopes = scopedToolNames(current)
        const scopeNames = scopedRunToolNames(
          current,
          scopes,
          scope,
          options.intersectScopes ?? [],
          {
            kind: "run",
            actor: run.authority.actor
          },
          options.shellByRules ?? false
        )
        const byName = new Map(current.map((tool) => [tool.definition.name, tool]))
        const approvals = async (_run: unknown, names: ReadonlyArray<string>) =>
          Effect.runPromise(
            approvalPolicy.decisions({
              runId: run.runId,
              authority: run.authority,
              tools: names.flatMap((name) => byName.get(name) ?? []),
              scopeNames: scopes
            })
          )
        const approvalGate = makeApprovalGate({
          review: approvalReview,
          policy: {
            live: (current) =>
              Effect.runPromise(
                approvalPolicy.live({ runId: current.runId, authority: current.authority })
              ),
            defer: ({ run: current, toolCallId, name, args, changesState, prompt }) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  const decoded = Schema.decodeUnknownOption(JsonObjectSchema)(args)
                  if (Option.isNone(decoded))
                    return yield* Effect.die(new Error(`${name} arguments are not JSON`))
                  const presentation = sanitizeApprovalPresentation(prompt.presentation)
                  yield* deferred.defer({
                    call: {
                      runId: current.runId,
                      sessionId: current.sessionId,
                      toolCallId,
                      toolName: name,
                      arguments: decoded.value,
                      changesState,
                      data: prompt.data
                    },
                    prompt: {
                      ...(prompt.preview === undefined ? {} : { preview: prompt.preview }),
                      ...(prompt.diff === undefined ? {} : { diff: prompt.diff }),
                      ...(prompt.data === undefined ? {} : { data: prompt.data }),
                      ...(presentation === undefined ? {} : { presentation })
                    }
                  })
                })
              ),
            offer: async ({ run: current, toolCallId, name, site }) => {
              const tool = byName.get(name)
              if (tool === undefined) return
              await offers
                .offer({
                  run: current,
                  toolCallId,
                  request:
                    site === undefined
                      ? { kind: "tool", tool: name, decision: "approve" }
                      : { kind: "site", tool: name, origin: site },
                  tools: [tool],
                  source: { kind: "approvals" }
                })
                .catch((cause: unknown) =>
                  Effect.runPromise(
                    Effect.logWarning("Permission offer failed", { tool: name, cause })
                  )
                )
            },
            refusals: ({ run: current, name }) =>
              Effect.runPromise(policy.refusedCalls({ runId: current.runId, toolName: name })),
            reach: ({ run: current, name, live }) => {
              const tool = byName.get(name)
              return tool === undefined
                ? { available: false, unattended_scope: false }
                : reachOf({ authority: current.authority, live, tool, scopeNames: scopes })
            }
          }
        })
        let bound: Toolset | undefined
        const codeMode = makeCodeModeHost({
          run,
          tools: current,
          scope: scopeNames,
          toolset: () => bound,
          browserObservations: observed.browserObservations,
          validateCall: (request) =>
            validateProcedureCall(procedureStore, run.runId, request, observed.browserObservations)
        })
        const nodes = makeWorkflowNodeRunner({
          tools: current,
          toolset: () => bound,
          scope: scopeNames,
          executionProfile: executionProfile(runTools),
          run,
          runs,
          transcript,
          models,
          catalog: modelCatalog
        })
        const scriptHost: ScriptHost = {
          ...nodes,
          agent: async (request, observer) => {
            if (
              (await Effect.runPromise(
                procedureStore.scope(run.runId, request.parentToolCallId)
              )) !== undefined
            )
              throw new ToolExecutionError("A saved browser procedure cannot start agents.", {
                preview: "Browser steps only",
                retryable: false
              })
            return nodes.agent(request, observer)
          },
          tool: codeMode.call,
          changesState: codeMode.changesState,
          describe: codeMode.describe,
          concurrencyGroup: codeMode.concurrencyGroup
        }
        const runScopeKeys = [scope, ...(options.intersectScopes ?? [])]
        const coreToolset = createToolset(current, {
          toJsonSchema: toolParametersJsonSchema,
          approvals,
          approvalGate,
          displayTitle: TOOL_DISPLAY_TITLE,
          scope: scopeNames,
          refusal: refusalText(run.authority)
        })({
          ...run,
          ...observed,
          mayUseBrowserTab: async (tabRef, toolCallId) => {
            const owner = await Effect.runPromise(procedureStore.tabOwner(tabRef))
            return (
              owner === undefined ||
              (owner.runId === run.runId &&
                toolCallId !== undefined &&
                (toolCallId === owner.parentToolCallId ||
                  toolCallId.startsWith(`${owner.parentToolCallId}:`)))
            )
          },
          codeMode,
          scriptHost,
          scriptHostFor: (other) => bindTools(scope, options, other, observedState()).workflowHost,
          offerPermission: ({ toolCallId, request }) =>
            offers.offer({ run, toolCallId, request, tools: current, source: { kind: "message" } }),
          readPermissions: () => offers.read(run, current)
        })
        bound = withMiddleware(coreToolset, [
          localizeOutputs({
            outputs,
            sessionId: run.sessionId,
            onResult: codeMode.captureResult
          }),
          ...(scope === "agent_research"
            ? [
                captureResearchSources({
                  run,
                  tools: current,
                  sessions,
                  workspace: researchWorkspace
                })
              ]
            : [])
        ])
        const guarded = withMiddleware(bound, [
          skillGuard(options.omitSkills === undefined ? {} : { omit: new Set(options.omitSkills) })
        ])
        const catalogContext = {
          scopes: options.declareTree === true ? (["all"] as const) : runScopeKeys,
          metadata: new Map(current.map((tool) => [tool.definition.name, tool.meta]))
        }
        const declared =
          options.declareTree === true
            ? async () => {
                const live = await Effect.runPromise(
                  approvalPolicy.live({ runId: run.runId, authority: run.authority })
                )
                const names = treeToolNames(current, scopes)
                return current
                  .filter(
                    (tool) =>
                      names.has(tool.definition.name) && toolRule(live, tool.definition) !== "never"
                  )
                  .map((tool) => tool.entry(toolParametersJsonSchema, TOOL_DISPLAY_TITLE))
              }
            : guarded.entries
        return {
          toolset: {
            ...guarded,
            entries: async () => applyToolCatalog(await declared(), catalogContext)
          },
          workflowHost: scriptHost
        }
      }

      const toolsRevision = () =>
        providers.map((provider) => provider.revision?.() ?? "").join("\n")

      const bindRun =
        (scope: ToolScopeKey, options: ScopedToolsetOptions = {}) =>
        (run: ServerToolRun): Toolset => {
          const observed = observedState()
          const revision = toolsRevision()
          return liveToolset({
            revision: toolsRevision,
            build: () => bindTools(scope, options, run, observed).toolset,
            initial: { revision, toolset: bindTools(scope, options, run, observed).toolset },
            onBuildFailure: (cause) =>
              void Effect.runPromise(
                Effect.logWarning("A running chat kept its tools: the new tool list failed", {
                  runId: run.runId,
                  cause
                })
              )
          })
        }

      return ServerToolRegistry.of(
        Object.freeze({
          catalog,
          ruleNames,
          settingsRuleSubjects,
          compileWords: compileFor,
          runToolset: Effect.fn("ServerToolRegistry.runToolset")(function* (run, options = {}) {
            const [scope, ...intersectScopes] = authorityScopes(run.authority)
            const shellByRules = yield* readJobShell(rules, run.authority)
            return bindRun(scope, { ...options, intersectScopes, shellByRules })(run)
          }),
          workflowHost: (scope, run) => bindTools(scope, {}, run, observedState()).workflowHost,
          ownedTools: (scopes) => ownedToolNames(builtins, scopes),
          applyApprovalEdits: ({ toolName, requested, patch }) => {
            const editor = cardTool(toolName)?.approvalEditor
            return editor === undefined
              ? { _tag: "Refused", reason: "This tool takes no edits on its approval card" }
              : editor.apply(requested, patch)
          },
          offersApprovalDraft: (toolName) => cardTool(toolName)?.offersDraft === true
        })
      )
    })
  )
}

export const RegistryWorkflowHost = Layer.effect(
  WorkflowHost,
  Effect.gen(function* () {
    const registry = yield* ServerToolRegistry
    return WorkflowHost.of({ forRun: (run) => registry.workflowHost("all", run) })
  })
)
