import { TOOL_APPROVAL_DECISION, type ToolApprovalDecision } from "@arden-hq/loop"
import {
  PERMISSION_RULE_DECISION,
  PERMISSION_RULE_LIST,
  PERMISSION_RULE_SUBJECT
} from "@arden-hq/protocol/permissions"
import { TOOL_APPROVAL_OVERRIDE } from "@arden-hq/protocol/tools"
import { TOOL_EFFECT } from "../execution/tool-effect.js"
import {
  PERMISSION_CHANGE,
  type OfferChoice,
  type OfferHolders,
  type PermissionChange
} from "../persistence/permissions/offer.js"
import { COMMAND_TOOL, type CommandPolicyRule } from "../persistence/permissions/command-policy.js"
import { RULE_CHANGE, settingOfRule, type RuleDecision } from "../persistence/permissions/rules.js"

import type { OfferFacts, OfferRefusal } from "./permission-offer-facts.js"

export const OFFER_PLAN = { offer: "offer", refuse: "refuse" } as const

export type OfferPlan =
  | {
      readonly kind: typeof OFFER_PLAN.offer
      readonly change: PermissionChange
      readonly choices: ReadonlyArray<OfferChoice>
    }
  | { readonly kind: typeof OFFER_PLAN.refuse; readonly reason: OfferRefusal }

export const refuse = (reason: OfferRefusal): OfferPlan => ({ kind: OFFER_PLAN.refuse, reason })

export const planPermissionOffer = (facts: OfferFacts): OfferPlan => {
  switch (facts.kind) {
    case PERMISSION_CHANGE.tool:
      return facts.decision === TOOL_APPROVAL_DECISION.approve
        ? planAllow(facts)
        : planToolSetting(facts)
    case PERMISSION_CHANGE.site:
      return planSite(facts)
    case PERMISSION_CHANGE.connector:
      return planConnector(facts)
    case PERMISSION_CHANGE.mode:
      return planMode(facts)
    case PERMISSION_CHANGE.command:
      return planCommand(facts)
    case PERMISSION_CHANGE.words:
      if (facts.text.length === 0) return refuse("no_words")
      return {
        kind: OFFER_PLAN.offer,
        change: {
          kind: PERMISSION_CHANGE.words,
          text: facts.text,
          decision: facts.decision,
          rules: facts.rules
        },
        choices: ruleChoices(facts.holders)
      }
    case PERMISSION_CHANGE.path:
      if (facts.path === undefined) return refuse("no_path")
      if (facts.tooWide) return refuse("too_wide")
      return {
        kind: OFFER_PLAN.offer,
        change: {
          kind: PERMISSION_CHANGE.path,
          path: facts.path,
          access: facts.access,
          decision: facts.decision
        },
        choices: ruleChoices(facts.holders)
      }
    case PERMISSION_CHANGE.rule:
      return planRule(facts)
  }
}

type ToolOfferFacts = Extract<OfferFacts, { kind: typeof PERMISSION_CHANGE.tool }>

export const settingOf = (rule: RuleDecision | undefined): ToolApprovalDecision | undefined =>
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

const setByPerson = (rule: ToolApprovalDecision | undefined): boolean =>
  rule === TOOL_APPROVAL_DECISION.ask || rule === TOOL_APPROVAL_DECISION.deny

const planAllow = (facts: ToolOfferFacts): OfferPlan => {
  const { tool, holders } = facts
  if (tool.always_ask) return refuse("always_asks")
  if (setByPerson(facts.rule)) return refuse("your_setting")
  if (facts.rule === TOOL_APPROVAL_DECISION.approve) return refuse("already_allowed")
  if (tool.name === COMMAND_TOOL) return refuse("own_rule")
  if (tool.default_approval === TOOL_APPROVAL_OVERRIDE.approve) return refuse("does_not_ask")
  return {
    kind: OFFER_PLAN.offer,
    change: {
      kind: PERMISSION_CHANGE.tool,
      tool: tool.name,
      decision: TOOL_APPROVAL_DECISION.approve
    },
    choices: ruleChoices(holders)
  }
}

const planSite = (
  facts: Extract<OfferFacts, { kind: typeof PERMISSION_CHANGE.site }>
): OfferPlan => {
  const { tool, holders } = facts
  if (tool.always_ask) return refuse("always_asks")
  if (setByPerson(facts.rule)) return refuse("your_setting")
  if (facts.rule === TOOL_APPROVAL_DECISION.approve) return refuse("already_allowed")
  if (tool.default_approval === TOOL_APPROVAL_OVERRIDE.approve) return refuse("does_not_ask")
  return {
    kind: OFFER_PLAN.offer,
    change: { kind: PERMISSION_CHANGE.site, tool: tool.name, origin: facts.origin },
    choices: ruleChoices(holders)
  }
}

const planToolSetting = (facts: ToolOfferFacts): OfferPlan => {
  if (facts.rule === facts.decision) return refuse("already_set")
  if (facts.tool.effect === TOOL_EFFECT.runRecord) return refuse("own_record")
  if (facts.decision === TOOL_APPROVAL_DECISION.ask && facts.tool.always_ask)
    return refuse("always_asks")
  return {
    kind: OFFER_PLAN.offer,
    change: { kind: PERMISSION_CHANGE.tool, tool: facts.tool.name, decision: facts.decision },
    choices: ruleChoices(facts.holders)
  }
}

const planConnector = (
  facts: Extract<OfferFacts, { kind: typeof PERMISSION_CHANGE.connector }>
): OfferPlan => {
  if (facts.tools === 0) return refuse("no_connector")
  if (setByPerson(facts.rule)) return refuse("your_setting")
  if (facts.rule === TOOL_APPROVAL_DECISION.approve) return refuse("already_allowed")
  return {
    kind: OFFER_PLAN.offer,
    change: { kind: PERMISSION_CHANGE.connector, server: facts.server },
    choices: ruleChoices(facts.holders)
  }
}

const planMode = (
  facts: Extract<OfferFacts, { kind: typeof PERMISSION_CHANGE.mode }>
): OfferPlan => {
  if (facts.holder === undefined) return refuse("mode_elsewhere")
  if (facts.holder.mode === facts.requested) return refuse("already_set")
  return {
    kind: OFFER_PLAN.offer,
    change: { kind: PERMISSION_CHANGE.mode, mode: facts.requested },
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

const planCommand = (
  facts: Extract<OfferFacts, { kind: typeof PERMISSION_CHANGE.command }>
): OfferPlan => {
  if (
    setByPerson(facts.rule) ||
    facts.alwaysAsk ||
    facts.grant.rule === PERMISSION_RULE_DECISION.ask ||
    facts.grant.rule === PERMISSION_RULE_DECISION.never
  )
    return refuse("your_setting")
  const chatRules =
    facts.grant.rule === PERMISSION_RULE_DECISION.allow ? undefined : facts.grant.offer?.rules
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
    return refuse(
      facts.grant.rule === PERMISSION_RULE_DECISION.allow ? "already_allowed" : "no_rule"
    )
  const rules = chatRules ?? systemRules ?? []
  return {
    kind: OFFER_PLAN.offer,
    change: { kind: PERMISSION_CHANGE.command, rules },
    choices: [
      ...(chatRules === undefined ? [] : ruleChoices(facts.holders)),
      ...(systemRules === undefined ? [] : [SYSTEM_CHOICE])
    ]
  }
}

const planRule = (
  facts: Extract<OfferFacts, { kind: typeof PERMISSION_CHANGE.rule }>
): OfferPlan => {
  const { rule, decision } = facts
  if (rule === undefined) return refuse("no_rule_id")
  if (rule.decision === decision) return refuse("already_set")
  if (
    rule.subject.kind === PERMISSION_RULE_SUBJECT.hostCommands &&
    decision !== RULE_CHANGE.ask &&
    decision !== RULE_CHANGE.remove
  )
    return refuse("host_commands")
  const label = decision === RULE_CHANGE.remove ? "Remove" : "Change"
  switch (rule.list.kind) {
    case PERMISSION_RULE_LIST.system:
      return refuse("system_list")
    case PERMISSION_RULE_LIST.global:
      return {
        kind: OFFER_PLAN.offer,
        change: { kind: PERMISSION_CHANGE.rule, ruleId: rule.id, decision },
        choices: [{ id: "everywhere", principal: null, label, detail: "" }]
      }
    case PERMISSION_RULE_LIST.space:
      return {
        kind: OFFER_PLAN.offer,
        change: { kind: PERMISSION_CHANGE.rule, ruleId: rule.id, decision },
        choices: [{ id: "space", principal: `space:${rule.list.spaceId}`, label, detail: "" }]
      }
  }
}
