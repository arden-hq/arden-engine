import type { ToolApprovalDecision } from "@arden-hq/loop"
import { Effect } from "effect"
import { quoted } from "@arden-hq/std/count"
import { collapseHome } from "@arden-hq/std/paths"
import { homedir } from "node:os"
import { canonicalRulePath, tooWide } from "../fs/protected-paths.js"
import type { CompiledWords } from "./rule-compile.js"
import { ruleDecision } from "../execution/rules.js"
import { personCard, waivesRequirement } from "../execution/decide.js"
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
  type OfferHolders,
  type OfferSource,
  type PermissionChange
} from "../persistence/permissions/offer.js"
import { COMMAND_TOOL, commandWords } from "../persistence/permissions/command-policy.js"
import type { PermissionStore } from "../persistence/permissions/store.js"
import type { WorkStore } from "../persistence/work/store.js"
import { toolFacts } from "./approval-decision.js"
import { toolRule, type LiveRead } from "./approval-policy.js"
import type { RunAuthority } from "../execution/authority.js"
import { type PermissionRule, type RuleSubject } from "../persistence/permissions/rules.js"
import type { HostCommandGrantPlan } from "./bash-permissions.js"
import type { ServerTool } from "./define.js"
import { APPROVAL_MODE_LABEL } from "./onboarding.js"
import type { ServerToolRun } from "../chat/runner-contract.js"
import type { PermissionOffers } from "./permission-offer-types.js"
import { LIST_WORDS } from "./permission-list-words.js"
import { type OfferFacts, type OfferRefusal, type OfferRequest } from "./permission-offer-facts.js"
import { planPermissionOffer, refuse, settingOf } from "./permission-offer-plan.js"

const OFFER_REFUSAL: Record<OfferRefusal, string> = {
  always_asks: "This tool always asks the person; no permission changes that.",
  your_setting:
    "The person set this themselves in Settings; their setting stays. Tell them where it is if they want it changed.",
  already_allowed: "This already runs without asking here.",
  already_set: "This is already set that way.",
  own_rule:
    "A command's own rule judges each call: offer its prefix with permission_offer (permission.command).",
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
    "The rule for commands on your Mac can only ask, or be removed. Offer a command's prefix with permission_offer (permission.command) instead.",
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
      return `${STANDING_DECISION_WORD[change.decision]} ${quoted(change.text)}?`
    case "rule": {
      if (held === undefined) return ""
      const rule = `${quoted(label)} ${held.list.kind === "space" ? "in this Space" : "everywhere"}`
      return change.decision === "remove"
        ? `Remove the rule ${rule}?`
        : `Change ${rule} from ${RULE_DECISION_WORD[held.decision]} to ${RULE_DECISION_WORD[change.decision]}?`
    }
  }
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
    case "vault_key":
      return `${RULE_ACTION.use} the ${subject.name} key`
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
}): PermissionOffers => {
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

export type PermissionsView = Awaited<ReturnType<ReturnType<typeof makePermissionOffers>["read"]>>
