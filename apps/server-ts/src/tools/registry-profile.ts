import { scopedToolNames } from "./tool-scopes.js"
import type { ToolScopeKey } from "../execution/policy.js"
import { type ServerTool, type ServerToolMetadata } from "./define.js"
import { internalStateTools } from "./internal-state.js"
import {
  TOOL_APPROVAL_OVERRIDE,
  type ToolCatalogEntry,
  type ToolPolicy
} from "@arden-hq/protocol/tools"
import { Effect, Schema } from "effect"
import { capabilityTools } from "./capability.js"
import { macTools } from "./mac-tools.js"
import { codeModeTools } from "./code-mode.js"
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
import type { ScriptAgentExecutionProfile } from "../workflows/runtime/contract.js"
import { mcpToolProvider } from "../mcp/provider.js"
import { browserPointerTools } from "./browser-pointer.js"
import { browserTools } from "./browser.js"
import { browserProcedureTools } from "./browser-procedure.js"
import { browserTaskTools } from "./browser-task.js"
import { browserUploadTools } from "./browser-upload.js"
import { chatFilesTools } from "./chat-files.js"
import { browserPermissionTools } from "./browser-permission.js"
import { vaultTools } from "./vault.js"
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
import { memoryForgetTools } from "./memory-forget.js"
import { wikiChangeTools } from "./wiki-change.js"
import { todoTools } from "./todos.js"
import { googleToolProvider } from "./google-provider.js"
import { directivesTools } from "./directives.js"
import { spawnAgentTools } from "./spawn-agent.js"
import { agentMessageTools } from "./agent-message.js"
import { workflowTools } from "./workflows.js"
import { workflowHash } from "../workflows/identity.js"
import { researchEvidenceTools } from "./research-evidence.js"
import { reportTools } from "./report.js"
import { tellTools } from "./tell.js"
import { toolParametersJsonSchema } from "./tool-json-schema.js"

export const builtinTools = Effect.all([
  internalStateTools,
  todoTools,
  directivesTools,
  sessionSearchTools,
  chatSummaryTools,
  capabilityTools,
  codeModeTools,
  macTools,
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
  vaultTools,
  artifactExportTools,
  artifactSaveTools,
  artifactDeleteTools,
  spawnAgentTools,
  agentMessageTools,
  skillTools,
  wikiTools,
  wikiOperationTools,
  memoryForgetTools,
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

export const toolProviders = Effect.all([googleToolProvider, mcpToolProvider])

const policy = (metadata: ServerToolMetadata): ToolPolicy => ({
  action: metadata.action,
  scope: metadata.policy_scope,
  requiresApproval: metadata.default_approval === TOOL_APPROVAL_OVERRIDE.ask,
  permissions: metadata.permissions
})

export const catalogEntry = (tool: ServerTool, description: string): ToolCatalogEntry => ({
  name: tool.definition.name,
  displayName: tool.meta.display_name,
  description,
  kind: tool.meta.kind,
  source: tool.meta.source,
  effectivePolicy: policy(tool.meta),
  defaultApproval: tool.meta.default_approval,
  display: tool.meta.display ?? []
})

export interface RuleNames {
  readonly tool: (
    name: string
  ) => { readonly title: string; readonly server: string | null } | undefined
  readonly connector: (server: string) => string | undefined
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

export type ExecutionProfileFor = (
  runTools: ReadonlyArray<ServerTool>
) => ScriptAgentExecutionProfile

export const makeExecutionProfile = (builtins: ReadonlyArray<ServerTool>): ExecutionProfileFor => {
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
        code: { changesState: code.some((tool) => tool.changes_state) },
        work: { changesState: true }
      }
    }
    last = { key, profile }
    return profile
  }
}
