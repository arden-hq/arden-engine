import type { ToolApprovalDecision } from "@arden-hq/loop"
import { Effect } from "effect"
import { quoted } from "@arden-hq/std/count"
import { collapseHome } from "@arden-hq/std/paths"
import { homedir } from "node:os"
import { canonicalRulePath, tooWide } from "../fs/protected-paths.js"
import type { CompiledWords } from "./rule-compile.js"
import type { PathAccess } from "../execution/rules.js"
import { personCard, waivesRequirement, type ToolFacts } from "../execution/decide.js"
import {
  DECISION_WORD,
  PATH_ACTION,
  PATH_DOING,
  RULE_ACTION,
  RULE_DECISION_WORD,
  STANDING_DECISION_WORD,
  type ApprovalMode
} from "@arden-hq/protocol/permissions"
import { parseMcpSource } from "../mcp/naming.js"
import {
  offerChoiceList,
  type OfferChoice,
  type OfferHolders,
  type OfferSource,
  type PermissionChange,
  type RuleChange
} from "../persistence/permissions/offer.js"
import {
  COMMAND_TOOL,
  commandWords,
  type CommandPolicyRule
} from "../persistence/permissions/command-policy.js"
import type { PermissionStore } from "../persistence/permissions/store.js"
import type { WorkStore } from "../persistence/work/store.js"
import { toolFacts } from "./approval-decision.js"
import { toolRule, type LiveRead } from "./approval-policy.js"
import { ruleDecision } from "../execution/rules.js"
import type { RunAuthority } from "../execution/authority.js"
import {
  settingOfRule,
  type PermissionRule,
  type RuleDecision,
  type RuleSubject
} from "../persistence/permissions/rules.js"
import type { HostCommandGrantPlan } from "./bash-permissions.js"
import type { ServerTool } from "./define.js"
import { APPROVAL_MODE_LABEL } from "./onboarding.js"
import type { ServerToolRun } from "../chat/runner-contract.js"

export type OfferRequest =
  | { readonly kind: "tool"; readonly tool: string; readonly decision: ToolApprovalDecision }
  | { readonly kind: "site"; readonly tool: string; readonly origin: string }
  | { readonly kind: "connector"; readonly server: string }
  | { readonly kind: "mode"; readonly mode: ApprovalMode }
  | { readonly kind: "command"; readonly command: string }
  | {
      readonly kind: "words"
      readonly text: string
      readonly decision: RuleDecision
      readonly rules?: ReadonlyArray<CompiledHardRule>
    }
  | {
      readonly kind: "path"
      readonly path: string
      readonly access: PathAccess
      readonly decision: "allow" | "never"
    }
  | { readonly kind: "rule"; readonly ruleId: string; readonly decision: RuleChange }

export type OfferFacts =
  | {
      readonly kind: "tool"
      readonly decision: ToolApprovalDecision
      readonly tool: ToolFacts
      readonly rule: ToolApprovalDecision | undefined
      readonly holders: OfferHolders
    }
  | {
      readonly kind: "site"
      readonly tool: ToolFacts
      readonly origin: string
      readonly rule: ToolApprovalDecision | undefined
      readonly holders: OfferHolders
    }
  | {
      readonly kind: "connector"
      readonly server: string
      readonly tools: number
      readonly rule: ToolApprovalDecision | undefined
      readonly holders: OfferHolders
    }
  | {
      readonly kind: "mode"
      readonly requested: ApprovalMode
      readonly holder:
        | {
            readonly principal: string
            readonly name: string
            readonly own: boolean
            readonly mode: ApprovalMode
          }
        | undefined
    }
  | {
      readonly kind: "command"
      readonly grant: HostCommandGrantPlan
      readonly system: HostCommandGrantPlan
      readonly alwaysAsk: boolean
      readonly rule: ToolApprovalDecision | undefined
      readonly holders: OfferHolders
    }
  | {
      readonly kind: "words"
      readonly text: string
      readonly decision: RuleDecision
      readonly rules: ReadonlyArray<CompiledHardRule>
      readonly holders: OfferHolders
    }
  | {
      readonly kind: "path"
      readonly path: string | undefined
      readonly access: PathAccess
      readonly decision: "allow" | "never"
      readonly tooWide: boolean
      readonly holders: OfferHolders
    }
  | {
      readonly kind: "rule"
      readonly rule: PermissionRule | undefined
      readonly decision: RuleChange
    }

type OfferRefusal =
  | "always_asks"
  | "your_setting"
  | "already_allowed"
  | "already_set"
  | "own_rule"
  | "own_record"
  | "does_not_ask"
  | "mode_elsewhere"
  | "no_rule"
  | "no_connector"
  | "no_tool"
  | "no_rule_id"
  | "no_words"
  | "no_path"
  | "not_compiled"
  | "too_wide"
  | "system_list"
  | "host_commands"
  | "no_holder"
  | "not_the_person"

export type OfferPlan =
  | {
      readonly kind: "offer"
      readonly change: PermissionChange
      readonly choices: ReadonlyArray<OfferChoice>
    }
  | { readonly kind: "refuse"; readonly reason: OfferRefusal }

const refuse = (reason: OfferRefusal): OfferPlan => ({ kind: "refuse", reason })

export const planPermissionOffer = (facts: OfferFacts): OfferPlan => {
  switch (facts.kind) {
    case "tool":
      return facts.decision === "approve" ? planAllow(facts) : planToolSetting(facts)
    case "site":
      return planSite(facts)
    case "connector":
      return planConnector(facts)
    case "mode":
      return planMode(facts)
    case "command":
      return planCommand(facts)
    case "words":
      if (facts.text.length === 0) return refuse("no_words")
      return {
        kind: "offer",
        change: { kind: "words", text: facts.text, decision: facts.decision, rules: facts.rules },
        choices: ruleChoices(facts.holders)
      }
    case "path":
      if (facts.path === undefined) return refuse("no_path")
      if (facts.tooWide) return refuse("too_wide")
      return {
        kind: "offer",
        change: {
          kind: "path",
          path: facts.path,
          access: facts.access,
          decision: facts.decision
        },
        choices: ruleChoices(facts.holders)
      }
    case "rule":
      return planRule(facts)
  }
}

type ToolOfferFacts = Extract<OfferFacts, { kind: "tool" }>

const settingOf = (rule: RuleDecision | undefined): ToolApprovalDecision | undefined =>
  rule === undefined ? undefined : settingOfRule(rule)

const ruleChoices = (holders: OfferHolders): ReadonlyArray<OfferChoice> => [
  ...(holders.shared === null
    ? []
    : [
        {
          id: "space" as const,
          principal: holders.shared.principal,
          label: "This Space",
          detail: ""
        }
      ]),
  { id: "everywhere", principal: null, label: "Everywhere", detail: "" }
]

const planAllow = (facts: ToolOfferFacts): OfferPlan => {
  const { tool, holders } = facts
  if (tool.always_ask) return refuse("always_asks")
  if (facts.rule === "ask" || facts.rule === "deny") return refuse("your_setting")
  if (facts.rule === "approve") return refuse("already_allowed")
  if (tool.name === COMMAND_TOOL) return refuse("own_rule")
  if (tool.default_approval === "approve") return refuse("does_not_ask")
  return {
    kind: "offer",
    change: { kind: "tool", tool: tool.name, decision: "approve" },
    choices: ruleChoices(holders)
  }
}

const planSite = (facts: Extract<OfferFacts, { kind: "site" }>): OfferPlan => {
  const { tool, holders } = facts
  if (tool.always_ask) return refuse("always_asks")
  if (facts.rule === "ask" || facts.rule === "deny") return refuse("your_setting")
  if (facts.rule === "approve") return refuse("already_allowed")
  if (tool.default_approval === "approve") return refuse("does_not_ask")
  return {
    kind: "offer",
    change: { kind: "site", tool: tool.name, origin: facts.origin },
    choices: ruleChoices(holders)
  }
}

const planToolSetting = (facts: ToolOfferFacts): OfferPlan => {
  if (facts.rule === facts.decision) return refuse("already_set")
  if (facts.tool.effect === "run_record") return refuse("own_record")
  if (facts.decision === "ask" && facts.tool.always_ask) return refuse("always_asks")
  return {
    kind: "offer",
    change: { kind: "tool", tool: facts.tool.name, decision: facts.decision },
    choices: ruleChoices(facts.holders)
  }
}

const planConnector = (facts: Extract<OfferFacts, { kind: "connector" }>): OfferPlan => {
  if (facts.tools === 0) return refuse("no_connector")
  if (facts.rule === "ask" || facts.rule === "deny") return refuse("your_setting")
  if (facts.rule === "approve") return refuse("already_allowed")
  return {
    kind: "offer",
    change: { kind: "connector", server: facts.server },
    choices: ruleChoices(facts.holders)
  }
}

const planMode = (facts: Extract<OfferFacts, { kind: "mode" }>): OfferPlan => {
  if (facts.holder === undefined) return refuse("mode_elsewhere")
  if (facts.holder.mode === facts.requested) return refuse("already_set")
  return {
    kind: "offer",
    change: { kind: "mode", mode: facts.requested },
    choices: [
      {
        id: "chat",
        principal: facts.holder.principal,
        label: facts.holder.own ? "In this chat" : `In ${facts.holder.name}`,
        detail: facts.holder.own ? facts.holder.name : ""
      }
    ]
  }
}

const SYSTEM_CHOICE: OfferChoice = {
  id: "system",
  principal: null,
  label: "Arden's own jobs",
  detail: ""
}

const planCommand = (facts: Extract<OfferFacts, { kind: "command" }>): OfferPlan => {
  if (
    facts.rule === "ask" ||
    facts.rule === "deny" ||
    facts.alwaysAsk ||
    facts.grant.rule === "ask" ||
    facts.grant.rule === "never"
  )
    return refuse("your_setting")
  const chatRules = facts.grant.rule === "allow" ? undefined : facts.grant.offer?.rules
  const key = (rule: CommandPolicyRule) =>
    JSON.stringify([rule.executable_path, rule.argument_prefix])
  const sameRules = (
    left: ReadonlyArray<CommandPolicyRule>,
    right: ReadonlyArray<CommandPolicyRule>
  ) =>
    left.length === right.length &&
    left.every((rule) => right.some((other) => key(other) === key(rule)))
  const jobsRules = facts.system.rule === undefined ? facts.system.offer?.rules : undefined
  const systemRules =
    chatRules !== undefined && jobsRules !== undefined && !sameRules(chatRules, jobsRules)
      ? undefined
      : jobsRules
  if (chatRules === undefined && systemRules === undefined)
    return refuse(facts.grant.rule === "allow" ? "already_allowed" : "no_rule")
  const rules = chatRules ?? systemRules ?? []
  return {
    kind: "offer",
    change: { kind: "command", rules },
    choices: [
      ...(chatRules === undefined ? [] : ruleChoices(facts.holders)),
      ...(systemRules === undefined ? [] : [SYSTEM_CHOICE])
    ]
  }
}

const planRule = (facts: Extract<OfferFacts, { kind: "rule" }>): OfferPlan => {
  const { rule, decision } = facts
  if (rule === undefined) return refuse("no_rule_id")
  if (rule.decision === decision) return refuse("already_set")
  if (rule.subject.kind === "host_commands" && decision !== "ask" && decision !== "remove")
    return refuse("host_commands")
  const label = decision === "remove" ? "Remove" : "Change"
  switch (rule.list.kind) {
    case "system":
      return refuse("system_list")
    case "global":
      return {
        kind: "offer",
        change: { kind: "rule", ruleId: rule.id, decision },
        choices: [{ id: "everywhere", principal: null, label, detail: "" }]
      }
    case "space":
      return {
        kind: "offer",
        change: { kind: "rule", ruleId: rule.id, decision },
        choices: [{ id: "space", principal: `space:${rule.list.spaceId}`, label, detail: "" }]
      }
  }
}

const OFFER_REFUSAL: Record<OfferRefusal, string> = {
  always_asks: "This tool always asks the person; no permission changes that.",
  your_setting:
    "The person set this themselves in Settings; their setting stays. Tell them where it is if they want it changed.",
  already_allowed: "This already runs without asking here.",
  already_set: "This is already set that way.",
  own_rule: "A command's own rule judges each call: offer its prefix with permission.command.",
  own_record: "This tool is the run's own record; it always runs.",
  does_not_ask: "This tool already runs without asking.",
  mode_elsewhere:
    "This run's approval mode is set by its Space or job, not by a chat; the person changes it there.",
  no_rule:
    "Arden keeps no lasting rule for this command (a shell, an interpreter, rm or sudo, or a command it cannot read). Each call asks.",
  no_connector: "This chat has no connector by that name.",
  no_tool: "This chat has no tool by that name.",
  too_wide:
    "That folder is too wide to allow (home, a folder above it, or one holding secrets). Name the project folder.",
  not_compiled:
    "Arden couldn't read those words into rules just now. Say what you need, or try the words again.",
  no_path: "Name the folder by its full path, or from ~.",
  no_words: "The rule has no words. Write what Arden may or may not do.",
  no_rule_id: "No rule this chat reads has that id. Read the rules with permissions_read.",
  host_commands:
    "The rule for commands on your Mac can only ask, or be removed. Offer a command's prefix with permission.command instead.",
  system_list:
    "That rule is on the list for Arden's own jobs; the person changes it in Settings, Permissions.",
  no_holder: "Nothing here can hold a lasting permission.",
  not_the_person:
    "Only the person's own turn offers a lasting permission. Say what you need in your report."
}

const offerRaisedByPerson = (actor: RunAuthority["actor"]): boolean => actor.kind === "person"

const offerTarget = (
  request: OfferRequest,
  tools: ReadonlyArray<ServerTool>,
  titles: ReadonlyMap<string, string>
): {
  readonly request: OfferRequest
  readonly tools: ReadonlyArray<ServerTool>
  readonly label: string
} => {
  switch (request.kind) {
    case "tool":
    case "site": {
      const named = tools.filter((tool) => tool.definition.name === request.tool)
      const tool = named[0]
      return {
        request,
        tools: named,
        label: tool?.definition.metadata.display_name ?? tool?.definition.name ?? ""
      }
    }
    case "connector": {
      const serverOf = (tool: ServerTool) =>
        parseMcpSource(tool.definition.metadata.source)?.serverName
      const servers = [...new Set(tools.flatMap((tool) => serverOf(tool) ?? []))]
      const wanted = request.server.trim().toLowerCase()
      const server =
        servers.find((name) => name === request.server) ??
        servers.find((name) => name.toLowerCase() === wanted) ??
        servers.find((name) => titles.get(name)?.toLowerCase() === wanted)
      if (server === undefined) return { request, tools: [], label: request.server }
      return {
        request: { kind: "connector", server },
        tools: tools.filter((tool) => serverOf(tool) === server),
        label: titles.get(server) ?? server
      }
    }
    case "mode":
    case "command":
    case "words":
    case "rule":
    case "path":
      return { request, tools: [], label: "" }
  }
}

const offerServer = (change: PermissionChange, tool: ServerTool | undefined): string | null => {
  switch (change.kind) {
    case "tool":
      return parseMcpSource(tool?.definition.metadata.source)?.serverName ?? null
    case "connector":
      return change.server
    case "site":
    case "mode":
    case "command":
    case "words":
    case "rule":
    case "path":
      return null
  }
}

export type OfferOutcome =
  | { readonly kind: "offered"; readonly questionId: string; readonly prompt: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "skipped" }

const APPROVALS_BEFORE_OFFER = 3

const TOOL_PROMPT: Record<ToolApprovalDecision, (label: string) => string> = {
  approve: (label) => `${STANDING_DECISION_WORD.allow} ${label}?`,
  ask: (label) => `${STANDING_DECISION_WORD.ask} ${label}?`,
  deny: (label) => `${STANDING_DECISION_WORD.never} ${label}?`
}

const offerPrompt = (
  change: PermissionChange,
  label: string,
  held: PermissionRule | undefined
): string => {
  switch (change.kind) {
    case "tool":
      return TOOL_PROMPT[change.decision](label)
    case "site":
      return `${DECISION_WORD.alwaysAllow} ${label} on ${new URL(change.origin).host}?`
    case "connector":
      return `${DECISION_WORD.alwaysAllow} ${label}?`
    case "mode":
      return `Switch to ${APPROVAL_MODE_LABEL[change.mode]}?`
    case "command":
      return `${DECISION_WORD.alwaysAllow} ${change.rules.map((rule) => rule.display_prefix).join(", ")}?`
    case "path":
      return `${STANDING_DECISION_WORD[change.decision]} ${PATH_DOING[change.access]} ${collapseHome(change.path)}?`
    case "words":
      return `Save the rule ${quoted(change.text)}?`
    case "rule": {
      if (held === undefined) return ""
      const rule = `${quoted(label)} ${held.list.kind === "space" ? "in this Space" : "everywhere"}`
      return change.decision === "remove"
        ? `Remove the rule ${rule}?`
        : `Change ${rule} from ${RULE_DECISION_WORD[held.decision]} to ${RULE_DECISION_WORD[change.decision]}?`
    }
  }
}

interface CompiledHardRule {
  readonly subject: RuleSubject
  readonly decision: RuleDecision
}

const wordsDetail = (
  change: Extract<PermissionChange, { kind: "words" }>,
  tools: ReadonlyArray<ServerTool>
): string | null => {
  const rules = change.rules ?? []
  if (rules.length === 0) return null
  return rules
    .map((rule) => `- ${RULE_DECISION_WORD[rule.decision]}: ${subjectWords(rule.subject, tools)}`)
    .join("\n")
}

const subjectWords = (subject: RuleSubject, tools: ReadonlyArray<ServerTool>): string => {
  const toolName = (name: string) =>
    tools.find((tool) => tool.definition.name === name)?.definition.metadata.display_name ?? name
  switch (subject.kind) {
    case "tool":
      return toolName(subject.tool)
    case "site":
      return `${toolName(subject.tool)} on ${new URL(subject.origin).host}`
    case "connector":
      return `${RULE_ACTION.use} ${subject.server}`
    case "command":
      return `${RULE_ACTION.run} ${commandWords(subject.executable, subject.argumentPrefix)}`
    case "host_commands":
      return RULE_ACTION.hostCommands
    case "words":
      return subject.text
    case "path":
      return `${PATH_ACTION[subject.access]} ${collapseHome(subject.path)}`
  }
}

export const makePermissionOffers = (services: {
  readonly permissions: PermissionStore["Service"]
  readonly work: WorkStore["Service"]
  readonly live: (run: ServerToolRun) => Promise<LiveRead>
  readonly modeHolder: (
    run: ServerToolRun
  ) => Promise<
    { readonly sessionId: string; readonly name: string; readonly mode: ApprovalMode } | undefined
  >
  readonly commandGrant: (
    run: ServerToolRun,
    command: string
  ) => Promise<{
    readonly grant: HostCommandGrantPlan
    readonly system: HostCommandGrantPlan
    readonly alwaysAsk: boolean
  }>
  readonly connectorTitles: () => Promise<ReadonlyMap<string, string>>
  readonly compileWords: (text: string, sessionId: string) => Promise<CompiledWords>
}) => {
  const factsOf = async (
    run: ServerToolRun,
    request: OfferRequest,
    tools: ReadonlyArray<ServerTool>,
    live: LiveRead,
    holders: OfferHolders
  ): Promise<OfferFacts | undefined> => {
    switch (request.kind) {
      case "tool": {
        const tool = tools[0]
        return tool === undefined
          ? undefined
          : {
              kind: "tool",
              decision: request.decision,
              tool: toolFacts(tool.definition),
              rule: settingOf(toolRule(live, tool.definition)),
              holders
            }
      }
      case "site": {
        const tool = tools[0]
        return tool === undefined
          ? undefined
          : {
              kind: "site",
              tool: toolFacts(tool.definition),
              origin: request.origin,
              rule: settingOf(toolRule(live, tool.definition, request.origin)),
              holders
            }
      }
      case "connector":
        return {
          kind: "connector",
          server: request.server,
          tools: tools.length,
          rule: settingOf(
            ruleDecision(
              live.rules,
              (subject) => subject.kind === "connector" && subject.server === request.server
            )
          ),
          holders
        }
      case "mode": {
        const holder = await services.modeHolder(run)
        return {
          kind: "mode",
          requested: request.mode,
          holder:
            holder === undefined
              ? undefined
              : {
                  principal: `chat:${holder.sessionId}`,
                  name: holder.name,
                  own: holder.sessionId === run.sessionId,
                  mode: holder.mode
                }
        }
      }
      case "command": {
        const { grant, system, alwaysAsk } = await services.commandGrant(run, request.command)
        return {
          kind: "command",
          grant,
          system,
          alwaysAsk,
          rule: settingOf(toolRule(live, { name: COMMAND_TOOL, metadata: { source: "_shell" } })),
          holders
        }
      }
      case "words":
        return {
          kind: "words",
          text: request.text,
          decision: request.decision,
          rules: request.rules ?? [],
          holders
        }
      case "path": {
        const path = await canonicalRulePath(request.path)
        return {
          kind: "path",
          path,
          access: request.access,
          decision: request.decision,
          tooWide:
            path !== undefined &&
            request.decision === "allow" &&
            tooWide(path, { stateRoots: [], home: homedir() }),
          holders
        }
      }
      case "rule":
        return {
          kind: "rule",
          rule: live.rules.rules.find((rule) => rule.id === request.ruleId),
          decision: request.decision
        }
    }
  }

  const offer = async (input: {
    readonly run: ServerToolRun
    readonly toolCallId: string
    readonly request: OfferRequest
    readonly tools: ReadonlyArray<ServerTool>
    readonly source: OfferSource
  }): Promise<OfferOutcome> => {
    const { run, source } = input
    const refused = (reason: OfferRefusal): OfferOutcome =>
      source.kind === "approvals"
        ? { kind: "skipped" }
        : { kind: "refused", reason: OFFER_REFUSAL[reason] }
    if (!offerRaisedByPerson(run.authority.actor)) return refused("not_the_person")
    const live = await services.live(run)
    if (source.kind === "approvals" && personCard(live.mode) !== "ask") return { kind: "skipped" }
    const compiled =
      input.request.kind === "words"
        ? await services.compileWords(input.request.text, run.sessionId).catch(() => undefined)
        : undefined
    if (input.request.kind === "words" && compiled === undefined) return refused("not_compiled")
    const request: OfferRequest =
      input.request.kind === "words" && compiled !== undefined
        ? {
            kind: "words",
            text: input.request.text,
            decision: compiled.decision,
            rules: compiled.rules.map((rule) => ({
              subject: rule.subject,
              decision: rule.decision
            }))
          }
        : input.request
    const titles =
      input.request.kind === "connector"
        ? await services.connectorTitles()
        : new Map<string, string>()
    const target = offerTarget(request, input.tools, titles)
    const tool =
      target.request.kind === "tool" || target.request.kind === "site" ? target.tools[0] : undefined
    const holders = await Effect.runPromise(services.permissions.offerHolders(run.runId))
    const facts =
      holders === null ? undefined : await factsOf(run, target.request, target.tools, live, holders)
    const plan =
      facts === undefined
        ? refuse(holders === null ? "no_holder" : "no_tool")
        : planPermissionOffer(facts)
    if (plan.kind === "refuse") return refused(plan.reason)
    const held = facts?.kind === "rule" ? facts.rule : undefined
    const label = held === undefined ? target.label : subjectWords(held.subject, input.tools)
    const serverName = offerServer(plan.change, tool)
    const kept = await Promise.all(
      plan.choices.map(async (choice) => {
        const list = offerChoiceList(choice)
        return (
          list === undefined ||
          (await Effect.runPromise(services.permissions.allowSaves(plan.change, serverName, list)))
        )
      })
    )
    const choices = plan.choices.filter((_, index) => kept[index] === true)
    if (choices.length === 0) return refused("your_setting")
    const history = await Effect.runPromise(
      services.permissions.offerHistory(run.runId, plan.change)
    )
    if (
      source.kind === "approvals" &&
      (history.approvals < APPROVALS_BEFORE_OFFER || history.offer !== "none")
    )
      return { kind: "skipped" }
    if (source.kind === "message" && history.offer === "open")
      return { kind: "refused", reason: "This permission is already offered; wait for the answer." }
    const question = await Effect.runPromise(
      services.work.askQuestion({
        runId: run.runId,
        toolCallId: input.toolCallId,
        content: {
          prompt: offerPrompt(plan.change, label, held),
          detail: plan.change.kind === "words" ? wordsDetail(plan.change, input.tools) : null,
          choices: choices.map(({ id, label: choice, detail }) => ({
            id,
            label: choice,
            ...(detail.trim().length > 0 ? { detail } : {})
          }))
        },
        permissionOffer: { change: plan.change, serverName, source, choices }
      })
    )
    return { kind: "offered", questionId: question.question_id, prompt: question.content.prompt }
  }

  const read = async (run: ServerToolRun, tools: ReadonlyArray<ServerTool>) => {
    const [live, holder, holders] = await Promise.all([
      services.live(run),
      services.modeHolder(run),
      Effect.runPromise(services.permissions.offerHolders(run.runId))
    ])
    const space = holders?.shared?.name ?? null
    return {
      mode: APPROVAL_MODE_LABEL[live.mode],
      modeSetBy: modeSetter(holder, run.sessionId),
      rules: live.rules.rules.map((rule) => ({
        id: rule.id,
        list:
          rule.list.kind === "space" ? `Space ${space ?? ""}`.trim() : LIST_WORDS[rule.list.kind],
        decision: rule.decision,
        rule: subjectWords(rule.subject, tools)
      })),
      ownChecks: tools.flatMap((tool) => {
        const facts = toolFacts(tool.definition)
        return facts.always_ask || (facts.per_call && !waivesRequirement(live.mode, facts))
          ? [tool.definition.metadata.display_name]
          : []
      })
    }
  }

  return { offer, read }
}

const modeSetter = (
  holder: { readonly sessionId: string; readonly name: string } | undefined,
  sessionId: string
): string => {
  if (holder === undefined) return "its Space or job"
  return holder.sessionId === sessionId ? "this chat" : `the chat ${quoted(holder.name, 80)}`
}

const LIST_WORDS = { global: "Everywhere", system: "Arden's own jobs" } as const

export type PermissionsView = Awaited<ReturnType<ReturnType<typeof makePermissionOffers>["read"]>>
