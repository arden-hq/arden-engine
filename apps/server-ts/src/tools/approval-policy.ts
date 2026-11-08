import type { ToolApprovalDecision } from "@arden-hq/loop"
import { Effect } from "effect"
import { authorityScopes, type RunAuthority } from "../execution/authority.js"
import type { CallFacts } from "../execution/decide.js"
import type { ApprovalMode } from "@arden-hq/protocol/permissions"
import type { ToolScopeKey } from "../execution/policy.js"
import type { ApprovalPolicyStore } from "../persistence/permissions/approval-policy.js"
import type { PermissionRules } from "../persistence/permissions/rules.js"
import {
  jobHoldsShell,
  matchesTool,
  readRunRules,
  ruleDecision,
  type RunRules
} from "../execution/rules.js"
import type { RuleDecision } from "../persistence/permissions/rules.js"
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

export const makeToolApprovalPolicy = (services: {
  readonly policy: ApprovalPolicyStore["Service"]
  readonly rules: PermissionRules["Service"]
}) => {
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
      result[name] = available && toolRule(read, tool.definition) !== "never" ? "approve" : "deny"
    }
    return result
  })

  return { live, decisions }
}

export type ToolApprovalPolicy = ReturnType<typeof makeToolApprovalPolicy>
