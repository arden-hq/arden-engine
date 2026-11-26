import {
  PERMISSION_PATH_ACCESS,
  PERMISSION_RULE_DECISION,
  PERMISSION_RULE_LIST,
  PERMISSION_RULE_SUBJECT,
  type PermissionPathAccess
} from "@arden-hq/protocol/permissions"
import { isWithin } from "@arden-hq/std/paths"
import { Effect } from "effect"
import type {
  PermissionRule,
  PermissionRules,
  PermissionRulesError,
  RuleDecision,
  RuleList,
  RuleSubject
} from "../persistence/permissions/rules.js"
import { ACTOR, rootOf, type RunAuthority } from "./authority.js"
import { APPROVAL_SOURCE, approvalSources } from "./approval-source.js"
import { firstAnswer, type Rung } from "./ladder.js"

export const ownRuleList = (authority: RunAuthority): RuleList | undefined => {
  if (authority.owns.space_id !== null)
    return { kind: PERMISSION_RULE_LIST.space, spaceId: authority.owns.space_id }
  const systemJob = approvalSources(authority.approval.follows).some(
    (source) => source.kind === APPROVAL_SOURCE.automation
  )
  return systemJob ? { kind: PERMISSION_RULE_LIST.system } : undefined
}

export const isSystemJobRun = (authority: RunAuthority): boolean =>
  rootOf(authority.actor) === ACTOR.automation &&
  ownRuleList(authority)?.kind === PERMISSION_RULE_LIST.system

const holdsSystemCommandAllow = (run: RunRules): boolean =>
  run.rules.some(
    (rule) =>
      rule.list.kind === PERMISSION_RULE_LIST.system &&
      rule.decision === PERMISSION_RULE_DECISION.allow &&
      rule.subject.kind === PERMISSION_RULE_SUBJECT.command
  )

export const jobHoldsShell = (authority: RunAuthority, run: RunRules): boolean =>
  authority.actor.kind === ACTOR.automation &&
  isSystemJobRun(authority) &&
  holdsSystemCommandAllow(run)

const readListRules = (
  store: PermissionRules["Service"],
  list: RuleList
): Effect.Effect<RunRules, PermissionRulesError> =>
  store.inLists([list]).pipe(Effect.map((rules) => ({ own: list, rules })))

export const readCommandViews = Effect.fn("PermissionRules.readCommandViews")(function* (
  store: PermissionRules["Service"],
  authority: RunAuthority
) {
  const run = yield* readRunRules(store, authority)
  const system = yield* readListRules(store, { kind: PERMISSION_RULE_LIST.system })
  return {
    run,
    system,
    alwaysAsk: ruleDecision(run, matchesHostCommands) === PERMISSION_RULE_DECISION.ask
  }
})

export const readJobShell = (
  store: PermissionRules["Service"],
  authority: RunAuthority
): Effect.Effect<boolean> =>
  readRunRules(store, authority).pipe(
    Effect.map((read) => jobHoldsShell(authority, read)),
    Effect.orElseSucceed(() => false)
  )

export const ruleListsOf = (authority: RunAuthority): ReadonlyArray<RuleList> => {
  const own = ownRuleList(authority)
  const global: RuleList = { kind: PERMISSION_RULE_LIST.global }
  return own === undefined ? [global] : [own, global]
}

export interface RunRules {
  readonly own: RuleList | undefined
  readonly rules: ReadonlyArray<PermissionRule>
}

export const sameList = (left: RuleList, right: RuleList): boolean => {
  if (left.kind !== right.kind) return false
  return (
    left.kind !== PERMISSION_RULE_LIST.space ||
    (right.kind === PERMISSION_RULE_LIST.space && left.spaceId === right.spaceId)
  )
}

const RANK: Record<RuleDecision, number> = { allow: 0, ask: 1, never: 2 }

const strongest = (rules: ReadonlyArray<PermissionRule>): RuleDecision | undefined =>
  rules.reduce<RuleDecision | undefined>(
    (held, rule) => (held === undefined || RANK[rule.decision] > RANK[held] ? rule.decision : held),
    undefined
  )

interface MatchedRules {
  readonly own: RuleList | undefined
  readonly global: ReadonlyArray<PermissionRule>
  readonly ownRules: ReadonlyArray<PermissionRule>
}

type RuleStage = Rung<MatchedRules, RuleDecision>

const globalNeverIsAFloor: RuleStage = {
  name: "global_never_is_a_floor",
  answer: ({ global }) =>
    global.some((rule) => rule.decision === PERMISSION_RULE_DECISION.never)
      ? PERMISSION_RULE_DECISION.never
      : undefined
}

const ownListDecides: RuleStage = {
  name: "own_list_decides",
  answer: ({ ownRules }) => strongest(ownRules)
}

const globalListDecides: RuleStage = {
  name: "global_list_decides",
  answer: ({ global }) => strongest(global)
}

const RULE_STAGES: ReadonlyArray<RuleStage> = [
  globalNeverIsAFloor,
  ownListDecides,
  globalListDecides
]

export const ruleDecision = (
  run: RunRules,
  matches: (subject: RuleSubject) => boolean
): RuleDecision | undefined => {
  const matched = run.rules.filter((rule) => matches(rule.subject))
  const own = run.own
  return firstAnswer(RULE_STAGES, {
    own,
    global: matched.filter((rule) => rule.list.kind === PERMISSION_RULE_LIST.global),
    ownRules: own === undefined ? [] : matched.filter((rule) => sameList(rule.list, own))
  })
}

export const matchesTool =
  (call: {
    readonly tool: string
    readonly server: string | null
    readonly site: string | undefined
  }): ((subject: RuleSubject) => boolean) =>
  (subject: RuleSubject): boolean => {
    switch (subject.kind) {
      case PERMISSION_RULE_SUBJECT.tool:
        return subject.tool === call.tool
      case PERMISSION_RULE_SUBJECT.site:
        return subject.tool === call.tool && subject.origin === call.site
      case PERMISSION_RULE_SUBJECT.connector:
        return call.server !== null && subject.server === call.server
      case PERMISSION_RULE_SUBJECT.command:
      case PERMISSION_RULE_SUBJECT.hostCommands:
      case PERMISSION_RULE_SUBJECT.words:
      case PERMISSION_RULE_SUBJECT.path:
      case PERMISSION_RULE_SUBJECT.vaultKey:
        return false
    }
  }

export const matchesVaultKey =
  (keyId: string): ((subject: RuleSubject) => boolean) =>
  (subject: RuleSubject): boolean =>
    subject.kind === PERMISSION_RULE_SUBJECT.vaultKey && subject.keyId === keyId

export const matchesCommand =
  (call: {
    readonly executable: string
    readonly arguments: ReadonlyArray<string>
  }): ((subject: RuleSubject) => boolean) =>
  (subject: RuleSubject): boolean =>
    subject.kind === PERMISSION_RULE_SUBJECT.command &&
    subject.executable === call.executable &&
    subject.argumentPrefix.every((part, index) => call.arguments[index] === part)

export const matchesHostCommands = (subject: RuleSubject): boolean =>
  subject.kind === PERMISSION_RULE_SUBJECT.hostCommands

export interface WordsRule {
  readonly text: string
  readonly decision: RuleDecision
}

export const wordsRules = (run: RunRules): ReadonlyArray<WordsRule> => {
  const words = (inList: (list: RuleList) => boolean) =>
    run.rules.flatMap((rule) =>
      rule.subject.kind === PERMISSION_RULE_SUBJECT.words && inList(rule.list)
        ? [{ text: rule.subject.text, decision: rule.decision }]
        : []
    )
  const own = run.own
  return [
    ...(own === undefined ? [] : words((list) => sameList(list, own))),
    ...words((list) => list.kind === PERMISSION_RULE_LIST.global)
  ]
}

export const readRunRules = (
  store: PermissionRules["Service"],
  authority: RunAuthority
): Effect.Effect<RunRules, PermissionRulesError> =>
  store
    .inLists(ruleListsOf(authority))
    .pipe(Effect.map((rules) => ({ own: ownRuleList(authority), rules })))

export type PathAccess = PermissionPathAccess

export interface PathTarget {
  readonly lexical: string
  readonly real: string
}

const within = (root: string, target: string, foldCase: boolean): boolean =>
  foldCase ? isWithin(root.toLowerCase(), target.toLowerCase()) : isWithin(root, target)

export const pathDecision = (
  run: RunRules,
  target: PathTarget,
  access: PathAccess,
  foldCase: boolean
): RuleDecision | undefined => {
  const paths = run.rules.flatMap((rule) =>
    rule.subject.kind === PERMISSION_RULE_SUBJECT.path
      ? [{ rule, path: rule.subject.path, access: rule.subject.access }]
      : []
  )
  const governs = (held: PathAccess, decision: RuleDecision) =>
    held === access ||
    (access === PERMISSION_PATH_ACCESS.read &&
      held === PERMISSION_PATH_ACCESS.change &&
      decision === PERMISSION_RULE_DECISION.allow) ||
    (access === PERMISSION_PATH_ACCESS.change &&
      held === PERMISSION_PATH_ACCESS.read &&
      decision === PERMISSION_RULE_DECISION.never)
  const never = paths.some(
    ({ rule, path, access: held }) =>
      rule.decision === PERMISSION_RULE_DECISION.never &&
      governs(held, PERMISSION_RULE_DECISION.never) &&
      (within(path, target.lexical, foldCase) || within(path, target.real, foldCase))
  )
  if (never) return PERMISSION_RULE_DECISION.never
  const own = run.own
  const rank = (rule: PermissionRule) => (own !== undefined && sameList(rule.list, own) ? 1 : 0)
  const held = paths
    .filter(
      ({ rule, path, access: kind }) =>
        rule.decision !== PERMISSION_RULE_DECISION.never &&
        governs(kind, rule.decision) &&
        within(path, target.real, false)
    )
    .sort(
      (left, right) =>
        right.path.length - left.path.length ||
        rank(right.rule) - rank(left.rule) ||
        RANK[right.rule.decision] - RANK[left.rule.decision]
    )
  return held[0]?.rule.decision
}
