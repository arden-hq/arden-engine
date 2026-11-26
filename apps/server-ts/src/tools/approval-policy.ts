import type { ToolApprovalDecision } from "@arden-hq/loop"
import { Effect } from "effect"
import { authorityScopes, type RunAuthority } from "../execution/authority.js"
import type { CallFacts } from "../execution/decide.js"
import { PERMISSION_RULE_DECISION, type ApprovalMode } from "@arden-hq/protocol/permissions"
import type { ToolScopeKey, RunCapability } from "../execution/policy.js"
import type {
  ApprovalPolicyStore,
  ApprovalPolicyError
} from "../persistence/permissions/approval-policy.js"
import type {
  PermissionRules,
  RuleDecision,
  PermissionRulesError
} from "../persistence/permissions/rules.js"
import {
  jobHoldsShell,
  matchesTool,
  readRunRules,
  ruleDecision,
  type RunRules
} from "../execution/rules.js"
import { parseMcpSource } from "../mcp/naming.js"
import type { ServerTool } from "./define.js"
import { toolAvailableInScopes, toolRunsUnattended } from "./tool-scopes.js"

export interface LiveRead {
  readonly state: "active" | "settling" | "revoked"
  readonly mode: ApprovalMode
  readonly noApproval: boolean
  readonly currentScope: ToolScopeKey | undefined
  readonly rules: RunRules
}

export const toolRule = (
  live: Pick<LiveRead, "rules">,
  tool: { readonly name: string; readonly metadata: { readonly source?: string | undefined } },
  site?: string
): RuleDecision | undefined =>
  ruleDecision(
    live.rules,
    matchesTool({
      tool: tool.name,
      server: parseMcpSource(tool.metadata.source)?.serverName ?? null,
      site
    })
  )

export const reachOf = (input: {
  readonly authority: RunAuthority
  readonly live: LiveRead
  readonly tool: ServerTool
  readonly scopeNames: Record<ToolScopeKey, ReadonlySet<string>>
}): Pick<CallFacts, "available" | "unattended_scope"> => {
  const { authority, live, tool } = input
  return {
    available: toolAvailableInScopes({
      tool,
      scopeNames: input.scopeNames,
      scopes: [
        ...authorityScopes(authority),
        ...(live.currentScope === undefined ? [] : [live.currentScope])
      ],
      primaryScopes: [authority.reach.capabilities[0]],
      holder: { kind: "run", actor: authority.actor },
      shellByRules: jobHoldsShell(authority, live.rules)
    }),
    unattended_scope: toolRunsUnattended(
      tool,
      live.currentScope === undefined ? authority.reach.capabilities : [live.currentScope]
    )
  }
}

export interface ToolApprovalPolicy {
  readonly live: (input: {
    readonly runId: string
    readonly authority: RunAuthority
  }) => Effect.Effect<
    {
      rules: RunRules
      state: "active" | "settling" | "revoked"
      mode: ApprovalMode
      noApproval: boolean
      currentScope: RunCapability | undefined
    },
    ApprovalPolicyError | PermissionRulesError
  >
  readonly decisions: (input: {
    readonly runId: string
    readonly authority: RunAuthority
    readonly tools: ReadonlyArray<ServerTool>
    readonly scopeNames: Record<ToolScopeKey, ReadonlySet<string>>
  }) => Effect.Effect<
    Record<string, ToolApprovalDecision>,
    ApprovalPolicyError | PermissionRulesError
  >
}

export const makeToolApprovalPolicy = (services: {
  readonly policy: ApprovalPolicyStore["Service"]
  readonly rules: PermissionRules["Service"]
}): ToolApprovalPolicy => {
  const live = Effect.fn("ToolApprovalPolicy.live")(function* (input: {
    readonly runId: string
    readonly authority: RunAuthority
  }) {
    const [current, rules] = yield* Effect.all([
      services.policy.live(input),
      readRunRules(services.rules, input.authority)
    ])
    return {
      ...current,
      rules
    } satisfies LiveRead
  })

  const decisions = Effect.fn("ToolApprovalPolicy.decisions")(function* (input: {
    readonly runId: string
    readonly authority: RunAuthority
    readonly tools: ReadonlyArray<ServerTool>
    readonly scopeNames: Record<ToolScopeKey, ReadonlySet<string>>
  }) {
    const result: Record<string, ToolApprovalDecision> = {}
    if (input.tools.length === 1) {
      for (const tool of input.tools) result[tool.definition.name] = "approve"
      return result
    }
    const read = yield* live(input)
    for (const tool of input.tools) {
      const name = tool.definition.name
      const { available } = reachOf({ ...input, live: read, tool })
      result[name] =
        available && toolRule(read, tool.definition) !== PERMISSION_RULE_DECISION.never
          ? "approve"
          : "deny"
    }
    return result
  })

  return { live, decisions }
}
