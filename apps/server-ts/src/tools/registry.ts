import { scopedRunToolNames, scopedToolNames } from "./tool-scopes.js"
import { makeReviewPlans } from "./review-plans.js"
import { RUN_CAPABILITY, type ToolScopeKey } from "../execution/policy.js"
import { summaryOf, type ServerTool } from "./define.js"
import { makeToolApprovalPolicy, reachOf, toolRule } from "./approval-policy.js"
import { ApprovalPolicyStore } from "../persistence/permissions/approval-policy.js"
import { ModelStore } from "../persistence/models/store.js"
import { ModelCatalog } from "../models/catalog.js"
import { createToolset, ToolExecutionError, type Toolset } from "@arden-hq/loop"
import type { ToolCatalogResponse } from "@arden-hq/protocol/tools"
import { PERMISSION_RULE_DECISION, type NewPermissionRule } from "@arden-hq/protocol/permissions"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { TranscriptQueries } from "../persistence/transcript/queries.js"
import {
  PermissionRules,
  PermissionRulesError,
  type RuleSubject
} from "../persistence/permissions/rules.js"
import { checkToolContract } from "./tool-contract.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { AutomationCatalog } from "../persistence/automations/catalog.js"
import { unlistedToolDisplay } from "./display.js"
import {
  applyToolCatalog,
  ownedToolNames,
  preloadToolNames,
  refusalText,
  treeToolNames,
  type ChatPreload
} from "./tool-catalog.js"
import { ModelProviderService } from "../models/provider.js"
import { UsageStore } from "../persistence/usage/store.js"
import { StructuredCompletion } from "../models/structured-completion.js"
import { TOOL_DISPLAY_TITLE } from "../execution/tool-call-presentation.js"
import { authorityScopes } from "../execution/authority.js"
import { makeApprovalGate } from "./approval-gate.js"
import { readJobShell } from "../execution/rules.js"
import { WorkStore } from "../persistence/work/store.js"
import type { ScriptHost } from "../workflows/runtime/contract.js"
import type { ServerToolRun } from "../chat/runner-contract.js"
import { WorkflowHost } from "../workflows/host.js"
import {
  makeBrowserObservationRegistry,
  makeObservationRegistry,
  type ServerRunContext
} from "./run-context.js"
import { liveToolset } from "./live-toolset.js"
import { PermissionStore } from "../persistence/permissions/store.js"
import { McpStore } from "../persistence/mcp/store.js"
import { DeferredToolCalls } from "../persistence/tools/deferred.js"
import { JsonObjectSchema } from "../persistence/json.js"
import { cleanApprovalDraft } from "../persistence/tools/approval-draft.js"
import { BrowserProcedureStore } from "../persistence/browser-procedures/store.js"
import { validateProcedureCall } from "../browser/procedures/guards.js"
import { vaultResultScrub } from "./vault.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { skillGuard } from "../skills/guard.js"
import { withMiddleware } from "../execution/toolset-middleware.js"
import { localizeOutputs } from "./localize-outputs.js"
import { makeCodeModeHost } from "./code-mode-host.js"
import { makeWorkflowNodeRunner } from "./workflow-node-runner.js"
import { ResearchWorkspace } from "../research/workspace.js"
import { captureResearchSources } from "./research-capture.js"
import { ManagedOutputs } from "../artifacts/managed-output/managed-output.js"
import { toolParametersJsonSchema } from "./tool-json-schema.js"
import { ROLE_TOOLS } from "../persistence/tools/tool-roles.js"
import type { ApprovalAlternativeInput, ApprovalEditsInput } from "../persistence/tools/store.js"
import { ToolExecutionStore } from "../persistence/tools/store.js"
import {
  type RuleNames,
  type ScopedToolsetOptions,
  builtinTools,
  catalogEntry,
  makeExecutionProfile,
  toolProviders
} from "./registry-profile.js"
import { makeRegistryOffers } from "./registry-offers.js"
import { makeRegistryApprovalReview } from "./registry-approval-review.js"
import { makeRegistryRules } from "./registry-rules.js"
import { type CompiledWords } from "./rule-compile.js"

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
    readonly preloadTools: (preload: ChatPreload) => ReadonlyArray<string>
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
      const executions = yield* ToolExecutionStore
      const structured = yield* StructuredCompletion
      const work = yield* WorkStore
      const mcpServers = yield* McpStore
      const approvalPolicy = makeToolApprovalPolicy({ policy, rules })
      const offers = makeRegistryOffers({
        permissions,
        work,
        approvalPolicy,
        policy,
        sessions,
        rules,
        mcpServers,
        compileWords: (text, sessionId) => Effect.runPromise(compileFor({ text, sessionId }))
      })
      const modelProvider = yield* ModelProviderService
      const usageStore = yield* UsageStore
      const approvalReview = makeRegistryApprovalReview({
        structured,
        policy,
        runs,
        sessions,
        transcript,
        automations,
        work,
        modelProvider,
        usageStore
      })
      const researchWorkspace = yield* ResearchWorkspace
      const outputs = yield* ManagedOutputs

      const procedureStore = yield* BrowserProcedureStore
      const scrub = yield* vaultResultScrub
      const builtins = yield* builtinTools
      const missingRole = ROLE_TOOLS.find(
        (name) => !builtins.some((tool) => tool.definition.name === name)
      )
      if (missingRole !== undefined) {
        return yield* Effect.die(new Error(`Tool role names an unregistered tool: ${missingRole}`))
      }
      const providers = yield* toolProviders
      yield* checkToolContract([...builtins, ...providers[0].catalog()])
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
                : (summaryOf(tool.definition) ?? "")
            )
          ),
          unlisted: unlistedToolDisplay(
            (name) => tools.find((tool) => tool.definition.name === name)?.meta.display
          )
        }
      })

      const { ruleNames, settingsRuleSubjects, compileFor } = makeRegistryRules({
        mcpServers,
        structured,
        publicTools
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
            live: (current) => Effect.runPromise(approvalPolicy.live(current)),
            defer: ({ run: current, toolCallId, name, args, changesState, prompt }) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  const decoded = Schema.decodeUnknownOption(JsonObjectSchema)(args)
                  if (Option.isNone(decoded))
                    return yield* Effect.die(new Error(`${name} arguments are not JSON`))
                  const presentation = cleanApprovalDraft(prompt.presentation)
                  return yield* deferred.defer({
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
            planned: (call) => Effect.runPromise(executions.admitPlanned(call)),
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
          scrub,
          scope: scopeNames,
          refusal: refusalText(run.authority)
        })({
          ...run,
          ...observed,
          mayUseBrowserTab: async (tabRef, toolCallId) => {
            const owner = await Effect.runPromise(procedureStore.tabOwner(tabRef))
            if (owner === undefined) return true
            if (owner.runId !== run.runId || toolCallId === undefined) return false
            const call = { runId: run.runId, toolCallId }
            return Effect.runPromise(executions.descends(call, owner.parentToolCallId))
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
          ...(scope === RUN_CAPABILITY.agentResearch
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
        const catalogScopes = options.declareTree === true ? (["all"] as const) : runScopeKeys
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
                      names.has(tool.definition.name) &&
                      toolRule(live, tool.definition) !== PERMISSION_RULE_DECISION.never
                  )
                  .map((tool) => tool.entry(toolParametersJsonSchema, TOOL_DISPLAY_TITLE))
              }
            : guarded.entries
        return {
          toolset: {
            ...guarded,
            entries: async () =>
              applyToolCatalog(await declared(), { scopes: catalogScopes, tools: byName })
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
          preloadTools: (preload) => preloadToolNames(builtins, preload),
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
