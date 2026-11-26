import { type ServerTool } from "./define.js"
import { PERMISSION_RULE_SUBJECT, type NewPermissionRule } from "@arden-hq/protocol/permissions"
import { Effect } from "effect"
import { canonicalRulePath } from "../fs/protected-paths.js"
import { compileWords, type CompiledWords } from "./rule-compile.js"
import {
  PermissionRulesError,
  wordsRuleText,
  type RuleSubject
} from "../persistence/permissions/rules.js"
import { toolTitle } from "./display.js"
import { StructuredCompletion } from "../models/structured-completion.js"
import { namedCommandGrant } from "./shell-policy.js"
import { parseMcpSource } from "../mcp/naming.js"
import { McpStore } from "../persistence/mcp/store.js"
import { mcpServiceTitle } from "../mcp/transport.js"
import { type RuleNames } from "./registry-profile.js"

export interface RegistryRules {
  readonly ruleNames: () => Effect.Effect<RuleNames, PermissionRulesError>
  readonly settingsRuleSubjects: (
    subject: NewPermissionRule["subject"]
  ) => Effect.Effect<ReadonlyArray<RuleSubject>, PermissionRulesError>
  readonly compileFor: (input: {
    readonly text: string
    readonly sessionId: string | null
  }) => Effect.Effect<CompiledWords, PermissionRulesError>
}

export const makeRegistryRules = ({
  mcpServers,
  structured,
  publicTools
}: {
  readonly mcpServers: McpStore["Service"]
  readonly structured: StructuredCompletion["Service"]
  readonly publicTools: () => ReadonlyArray<ServerTool>
}): RegistryRules => {
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
      case PERMISSION_RULE_SUBJECT.tool: {
        const tool = publicTools().find((candidate) => candidate.definition.name === subject.tool)
        if (tool === undefined) return yield* invalid(`Unknown tool: ${subject.tool}`)
        if (tool.meta.always_ask === true) return yield* invalid("Arden always asks before this")
        return [{ kind: "tool", tool: subject.tool, server: serverOf(tool) }]
      }
      case PERMISSION_RULE_SUBJECT.connector:
        return [{ kind: "connector", server: subject.server }]
      case PERMISSION_RULE_SUBJECT.command: {
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
      case PERMISSION_RULE_SUBJECT.hostCommands:
        return [{ kind: "host_commands" }]
      case PERMISSION_RULE_SUBJECT.words:
        return [{ kind: "words", text: wordsRuleText(subject.text) }]
      case PERMISSION_RULE_SUBJECT.path: {
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
  }): Effect.fn.Return<CompiledWords, PermissionRulesError> {
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
  return { ruleNames, settingsRuleSubjects, compileFor }
}
