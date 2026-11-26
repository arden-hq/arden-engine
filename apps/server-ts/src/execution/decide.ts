import {
  ACTOR,
  actsAsPerson,
  isUserAutomation,
  rootOf,
  type Actor,
  type RunAuthority
} from "./authority.js"
import {
  APPROVAL_MODE,
  PERMISSION_RULE_DECISION,
  type ApprovalMode
} from "@arden-hq/protocol/permissions"
import {
  TOOL_ACTION,
  TOOL_APPROVAL_OVERRIDE,
  type ToolAction,
  type ToolDefaultApproval
} from "@arden-hq/protocol/tools"
import { TOOL_EFFECT, type ToolEffect } from "./tool-effect.js"
import type { RuleDecision } from "../persistence/permissions/rules.js"
import { CALL_IMPACT, readsOnly, type CallImpact } from "./impact.js"
import { firstAnswer, type Rung } from "./ladder.js"

const READ_ONLY_MODE = { selfGated: "self_gated" } as const
type ReadOnlyMode = (typeof READ_ONLY_MODE)[keyof typeof READ_ONLY_MODE]

const TOOL_STANDING = { always: "always", requirement: "requirement" } as const
type ToolStanding = (typeof TOOL_STANDING)[keyof typeof TOOL_STANDING]

export interface ToolFacts {
  readonly name: string
  readonly effect: ToolEffect
  readonly action: Exclude<ToolAction, typeof TOOL_ACTION.draft>
  readonly changes_state: boolean
  readonly read_only_mode: ReadOnlyMode | undefined
  readonly default_approval: ToolDefaultApproval
  readonly always_ask: boolean
  readonly approval_bypass: boolean
  readonly refuse_unattended: boolean
  readonly per_call: boolean
  readonly standing: ToolStanding | undefined
}

export interface CallFacts {
  readonly tool: ToolFacts
  readonly available: boolean
  readonly unattended_scope: boolean
  readonly floor: Floor | undefined
  readonly target: Target | undefined
  readonly requirement: boolean
  readonly user_only: boolean
  readonly impact: CallImpact
  readonly reads_only: boolean
  readonly approved: boolean
}

const AUTHORITY_STATE = {
  active: "active",
  settling: "settling",
  revoked: "revoked"
} as const
type AuthorityState = (typeof AUTHORITY_STATE)[keyof typeof AUTHORITY_STATE]

export interface LiveSettings {
  readonly state: AuthorityState
  readonly mode: ApprovalMode
  readonly rule: RuleDecision | undefined
}

type Floor = "destructive_command"

const TARGET = {
  spaceWork: "space_work",
  spaceControl: "space_control",
  directives: "directives",
  memoryForget: "memory_forget",
  chatBrowse: "chat_browse",
  chat: "chat"
} as const

const SPACE_WORK_OP = { create: "create", change: "change" } as const
type SpaceWorkOp = (typeof SPACE_WORK_OP)[keyof typeof SPACE_WORK_OP]

const CHAT_BROWSE_SCOPE = { space: "space", allSpaces: "all_spaces" } as const
type ChatBrowseScope = (typeof CHAT_BROWSE_SCOPE)[keyof typeof CHAT_BROWSE_SCOPE]

const CHAT_VERB = { message: "message", change: "change", open: "open" } as const
type ChatVerb = (typeof CHAT_VERB)[keyof typeof CHAT_VERB]

export type Target =
  | {
      readonly kind: typeof TARGET.spaceWork
      readonly requested_space_id: string | undefined
      readonly chat_space_id: string | undefined
      readonly op: SpaceWorkOp
    }
  | { readonly kind: typeof TARGET.spaceControl }
  | { readonly kind: typeof TARGET.directives }
  | { readonly kind: typeof TARGET.memoryForget }
  | { readonly kind: typeof TARGET.chatBrowse; readonly scope: ChatBrowseScope }
  | {
      readonly kind: typeof TARGET.chat
      readonly verb: ChatVerb
      readonly other_space: boolean
      readonly handed: boolean
    }

export const PATH = { tool: "tool", askUser: "ask_user", report: "report" } as const

export type Path =
  | { readonly kind: typeof PATH.tool; readonly name: string }
  | { readonly kind: typeof PATH.askUser }
  | { readonly kind: typeof PATH.report }

const ASK_USER: Path = { kind: PATH.askUser }
const REPORT: Path = { kind: PATH.report }

export type DenyRule =
  | "revoked"
  | "settling"
  | "user_deny"
  | "floor"
  | "reach"
  | "boundary"
  | "read_only"

export type AskReason =
  | "always_ask"
  | "standing"
  | "boundary"
  | "override"
  | "requirement"
  | "locked"
  | "default"

export const VERDICT = { allow: "allow", ask: "ask", deny: "deny" } as const
export type Verdict = (typeof VERDICT)[keyof typeof VERDICT]

export type Decision =
  | {
      readonly kind: typeof VERDICT.allow
      readonly by: "rule" | "mode" | "grant" | "user" | "default"
    }
  | {
      readonly kind: typeof VERDICT.ask
      readonly reason: AskReason
      readonly presentation: {
        readonly helper: boolean
        readonly delivery: "pause" | "chat" | "refuse"
      }
    }
  | {
      readonly kind: typeof VERDICT.deny
      readonly rule: DenyRule
      readonly instead: ReadonlyArray<Path>
    }

type Answer =
  | Exclude<Decision, { readonly kind: typeof VERDICT.ask }>
  | { readonly kind: typeof VERDICT.ask; readonly reason: AskReason; readonly helper: boolean }

interface CallContext {
  readonly authority: RunAuthority
  readonly live: LiveSettings
  readonly call: CallFacts
  readonly bounded: BoundaryVerdict | undefined
  readonly runRecord: boolean
  readonly helper: boolean
}

type DecisionRung = Rung<CallContext, Answer>

const allow = (by: Extract<Decision, { kind: typeof VERDICT.allow }>["by"]): Answer => ({
  kind: VERDICT.allow,
  by
})

const ask = (reason: AskReason, helper: boolean): Answer => ({
  kind: VERDICT.ask,
  reason,
  helper
})

const revoked: DecisionRung = {
  name: "revoked",
  answer: ({ live }) => (live.state === AUTHORITY_STATE.revoked ? deny("revoked", []) : undefined)
}

const settling: DecisionRung = {
  name: "settling",
  answer: ({ live, runRecord }) =>
    live.state === AUTHORITY_STATE.settling && !runRecord ? deny("settling", []) : undefined
}

const userNever: DecisionRung = {
  name: "user_never",
  answer: ({ live }) =>
    live.rule === PERMISSION_RULE_DECISION.never ? deny("user_deny", [ASK_USER]) : undefined
}

const destructiveFloor: DecisionRung = {
  name: "destructive_floor",
  answer: ({ call }) => (call.floor !== undefined ? deny("floor", [ASK_USER]) : undefined)
}

const toolOutOfReach: DecisionRung = {
  name: "tool_out_of_reach",
  answer: ({ authority, call }) =>
    !call.available ? deny("reach", refusalPath(authority.actor)) : undefined
}

const targetOutOfBounds: DecisionRung = {
  name: "target_out_of_bounds",
  answer: ({ bounded }) =>
    bounded?.kind === VERDICT.deny ? deny("boundary", bounded.instead) : undefined
}

const ownRunRecord: DecisionRung = {
  name: "own_run_record",
  answer: ({ runRecord }) => (runRecord ? allow("rule") : undefined)
}

const readOnlyRefusesChanges: DecisionRung = {
  name: "read_only_refuses_changes",
  answer: ({ authority, live, call }) => {
    const reads =
      readsOnly(call.tool) ||
      (call.tool.read_only_mode === READ_ONLY_MODE.selfGated && call.reads_only)
    return live.mode === APPROVAL_MODE.readOnly && !reads
      ? deny("read_only", refusalPath(authority.actor))
      : undefined
  }
}

const toolAlwaysAsks: DecisionRung = {
  name: "tool_always_asks",
  answer: ({ call }) => (call.tool.always_ask ? ask("always_ask", false) : undefined)
}

const automationStandingChange: DecisionRung = {
  name: "automation_standing_change",
  answer: ({ authority, call }) =>
    isUserAutomation(authority.actor) && standingChange(call) ? ask("standing", false) : undefined
}

const boundaryAsks: DecisionRung = {
  name: "boundary_asks",
  answer: ({ live, bounded }) =>
    bounded?.kind === VERDICT.ask && !skipsCards(live.mode) ? ask("boundary", false) : undefined
}

const lockedImpact: DecisionRung = {
  name: "locked_impact",
  answer: ({ call }) => (call.impact.kind === CALL_IMPACT.locked ? ask("locked", false) : undefined)
}

const readOnlyMode: DecisionRung = {
  name: "read_only_mode",
  answer: ({ live, call, helper }) => {
    if (live.mode !== APPROVAL_MODE.readOnly) return undefined
    return call.requirement ? ask("requirement", helper) : allow("rule")
  }
}

const callRequirement: DecisionRung = {
  name: "call_requirement",
  answer: ({ live, call, helper }) =>
    call.requirement && !waivesRequirement(live.mode, call.tool)
      ? ask("requirement", helper)
      : undefined
}

const ruleAsks: DecisionRung = {
  name: "rule_asks",
  answer: ({ live, helper }) =>
    live.rule === PERMISSION_RULE_DECISION.ask ? ask("override", helper) : undefined
}

const ruleAllows: DecisionRung = {
  name: "rule_allows",
  answer: ({ live }) => (live.rule === PERMISSION_RULE_DECISION.allow ? allow("grant") : undefined)
}

const allowMode: DecisionRung = {
  name: "allow_mode",
  answer: ({ live }) => (live.mode === APPROVAL_MODE.allow ? allow("mode") : undefined)
}

const unattendedScope: DecisionRung = {
  name: "unattended_scope",
  answer: ({ call }) => (call.unattended_scope ? allow("grant") : undefined)
}

const impactSettles: DecisionRung = {
  name: "impact_settles",
  answer: ({ live, call }) => (settledByImpact(live.mode, call.impact) ? allow("mode") : undefined)
}

const toolDefault = ({ call, helper }: CallContext): Answer =>
  call.tool.default_approval === TOOL_APPROVAL_OVERRIDE.ask
    ? ask("default", helper)
    : allow("default")

const DECISION_RUNGS: ReadonlyArray<DecisionRung> = [
  revoked,
  settling,
  userNever,
  destructiveFloor,
  toolOutOfReach,
  targetOutOfBounds,
  ownRunRecord,
  readOnlyRefusesChanges,
  toolAlwaysAsks,
  automationStandingChange,
  boundaryAsks,
  lockedImpact,
  readOnlyMode,
  callRequirement,
  ruleAsks,
  ruleAllows,
  allowMode,
  unattendedScope,
  impactSettles
]

export const decide = (authority: RunAuthority, live: LiveSettings, call: CallFacts): Decision => {
  const context: CallContext = {
    authority,
    live,
    call,
    bounded: call.target === undefined ? undefined : boundary(authority, call.target),
    runRecord: call.tool.effect === TOOL_EFFECT.runRecord,
    helper: live.mode === APPROVAL_MODE.safe && !(call.requirement && call.user_only)
  }
  const answer = firstAnswer(DECISION_RUNGS, context) ?? toolDefault(context)
  if (answer.kind !== VERDICT.ask) return answer
  if (call.approved) return { kind: VERDICT.allow, by: "user" }
  return {
    kind: VERDICT.ask,
    reason: answer.reason,
    presentation: { helper: answer.helper, delivery: delivery(authority, call) }
  }
}

const delivery = (authority: RunAuthority, call: CallFacts): "pause" | "chat" | "refuse" => {
  if (authority.unattended) return call.tool.refuse_unattended ? "refuse" : "chat"
  return authority.actor.kind === ACTOR.agent && !call.tool.refuse_unattended ? "chat" : "pause"
}

const settledByImpact = (mode: ApprovalMode, impact: CallImpact): boolean =>
  impact.kind === CALL_IMPACT.inert ||
  (impact.kind === CALL_IMPACT.contained && mode === APPROVAL_MODE.safe)

export const skipsCards = (mode: ApprovalMode): boolean => mode === APPROVAL_MODE.allow

export const waivesRequirement = (
  mode: ApprovalMode,
  tool: { readonly approval_bypass?: boolean; readonly always_ask?: boolean }
): boolean => skipsCards(mode) && tool.approval_bypass === true && tool.always_ask !== true

export type PersonCardOutcome = "ask" | "never_ask" | "read_only"

export const personCard = (mode: ApprovalMode): PersonCardOutcome => {
  if (mode === APPROVAL_MODE.readOnly) return "read_only"
  return skipsCards(mode) ? "never_ask" : "ask"
}

export const boundaryReach = (
  authority: RunAuthority,
  target: Target,
  input: { readonly mode: ApprovalMode; readonly approved: boolean }
): Verdict => {
  const verdict = boundary(authority, target)
  if (verdict.kind !== VERDICT.ask) return verdict.kind
  return input.approved || skipsCards(input.mode) ? VERDICT.allow : VERDICT.ask
}

const standingChange = (call: CallFacts): boolean =>
  call.tool.standing === TOOL_STANDING.always ||
  (call.tool.standing === TOOL_STANDING.requirement && call.requirement)

const deny = (
  rule: DenyRule,
  instead: ReadonlyArray<Path>
): Extract<Decision, { kind: typeof VERDICT.deny }> => ({
  kind: VERDICT.deny,
  rule,
  instead
})

export const refusalPath = (actor: Actor): ReadonlyArray<Path> => {
  switch (actor.kind) {
    case ACTOR.person:
      return [ASK_USER]
    case ACTOR.agent:
      return [REPORT]
    case ACTOR.automation:
      return [ASK_USER, REPORT]
    case ACTOR.taskWorker:
      return [{ kind: PATH.tool, name: "task_comment" }, ASK_USER, REPORT]
    case ACTOR.spaceReview:
    case ACTOR.unrecorded:
      return [REPORT]
  }
}

type WorkReach = "full" | "job" | "delegate"

export type BoundaryVerdict =
  | { readonly kind: typeof VERDICT.allow; readonly reach: WorkReach | undefined }
  | { readonly kind: typeof VERDICT.ask }
  | { readonly kind: typeof VERDICT.deny; readonly instead: ReadonlyArray<Path> }

const ALLOW: BoundaryVerdict = { kind: VERDICT.allow, reach: undefined }

const deniedTo = (instead: ReadonlyArray<Path>): BoundaryVerdict => ({
  kind: VERDICT.deny,
  instead
})

interface BoundaryInput<Kind extends Target["kind"]> {
  readonly authority: RunAuthority
  readonly target: Extract<Target, { kind: Kind }>
}

type BoundaryRule<Kind extends Target["kind"]> = Rung<BoundaryInput<Kind>, BoundaryVerdict>

const ownSpaceOrChatSpace = ({ authority, target }: BoundaryInput<typeof TARGET.spaceWork>) =>
  authority.owns.space_id ?? target.chat_space_id

const namesAnotherSpace = (input: BoundaryInput<typeof TARGET.spaceWork>): boolean => {
  const own = ownSpaceOrChatSpace(input)
  const requested = input.target.requested_space_id
  return requested !== undefined && own !== undefined && requested !== own
}

const personReachesEverySpace: BoundaryRule<typeof TARGET.spaceWork> = {
  name: "person_reaches_every_space",
  answer: ({ authority }) =>
    actsAsPerson(authority.actor) ? { kind: VERDICT.allow, reach: "full" } : undefined
}

const unrecordedOnlyReports: BoundaryRule<typeof TARGET.spaceWork> = {
  name: "unrecorded_only_reports",
  answer: ({ authority }) =>
    rootOf(authority.actor) === ACTOR.unrecorded ? deniedTo([REPORT]) : undefined
}

const onlyPersonStartsTasks: BoundaryRule<typeof TARGET.spaceWork> = {
  name: "only_person_starts_tasks",
  answer: ({ authority, target }) =>
    target.op === SPACE_WORK_OP.create ? deniedTo(refusalPath(authority.actor)) : undefined
}

const personsAgentKeepsGrantedSpace: BoundaryRule<typeof TARGET.spaceWork> = {
  name: "persons_agent_keeps_granted_space",
  answer: (input) => {
    if (rootOf(input.authority.actor) !== ACTOR.person) return undefined
    return namesAnotherSpace(input)
      ? deniedTo([REPORT])
      : { kind: VERDICT.allow, reach: "delegate" }
  }
}

const jobKeepsToOwnSpace: BoundaryRule<typeof TARGET.spaceWork> = {
  name: "job_keeps_to_own_space",
  answer: (input) =>
    namesAnotherSpace(input) && input.target.op === SPACE_WORK_OP.change
      ? deniedTo(refusalPath(input.authority.actor))
      : undefined
}

const SPACE_WORK_RULES: ReadonlyArray<BoundaryRule<typeof TARGET.spaceWork>> = [
  personReachesEverySpace,
  unrecordedOnlyReports,
  onlyPersonStartsTasks,
  personsAgentKeepsGrantedSpace,
  jobKeepsToOwnSpace
]

const JOB_REACH: BoundaryVerdict = { kind: VERDICT.allow, reach: "job" }

const personOnlyControl = (authority: RunAuthority): BoundaryVerdict =>
  actsAsPerson(authority.actor) ? ALLOW : deniedTo([ASK_USER])

const personBrowsesEveryChat: BoundaryRule<typeof TARGET.chatBrowse> = {
  name: "person_browses_every_chat",
  answer: ({ authority }) => (actsAsPerson(authority.actor) ? ALLOW : undefined)
}

const anyoneBrowsesOwnSpace: BoundaryRule<typeof TARGET.chatBrowse> = {
  name: "anyone_browses_own_space",
  answer: ({ target }) => (target.scope === CHAT_BROWSE_SCOPE.space ? ALLOW : undefined)
}

const spaceReviewReadsEveryChat: BoundaryRule<typeof TARGET.chatBrowse> = {
  name: "space_review_reads_every_chat",
  answer: ({ authority }) => (rootOf(authority.actor) === ACTOR.spaceReview ? ALLOW : undefined)
}

const CHAT_BROWSE_RULES: ReadonlyArray<BoundaryRule<typeof TARGET.chatBrowse>> = [
  personBrowsesEveryChat,
  anyoneBrowsesOwnSpace,
  spaceReviewReadsEveryChat
]

const sameSpaceChat: BoundaryRule<typeof TARGET.chat> = {
  name: "same_space_chat",
  answer: ({ target }) => (!target.other_space ? ALLOW : undefined)
}

const userAutomationActsAsPerson: BoundaryRule<typeof TARGET.chat> = {
  name: "user_automation_acts_as_person",
  answer: ({ authority, target }) =>
    isUserAutomation(authority.actor) && target.verb !== CHAT_VERB.open ? ALLOW : undefined
}

const personMessagesAnotherSpace: BoundaryRule<typeof TARGET.chat> = {
  name: "person_messages_another_space",
  answer: ({ authority, target }) => {
    if (authority.actor.kind !== ACTOR.person || target.verb !== CHAT_VERB.message) return undefined
    return target.handed ? ALLOW : { kind: VERDICT.ask }
  }
}

const personOpensAnyChat: BoundaryRule<typeof TARGET.chat> = {
  name: "person_opens_any_chat",
  answer: ({ authority, target }) =>
    authority.actor.kind === ACTOR.person && target.verb === CHAT_VERB.open ? ALLOW : undefined
}

const CHAT_RULES: ReadonlyArray<BoundaryRule<typeof TARGET.chat>> = [
  sameSpaceChat,
  userAutomationActsAsPerson,
  personMessagesAnotherSpace,
  personOpensAnyChat
]

export const boundary = (authority: RunAuthority, target: Target): BoundaryVerdict => {
  switch (target.kind) {
    case TARGET.spaceWork:
      return firstAnswer(SPACE_WORK_RULES, { authority, target }) ?? JOB_REACH
    case TARGET.spaceControl:
    case TARGET.directives:
    case TARGET.memoryForget:
      return personOnlyControl(authority)
    case TARGET.chatBrowse:
      return (
        firstAnswer(CHAT_BROWSE_RULES, { authority, target }) ??
        deniedTo([{ kind: PATH.tool, name: "session_read" }])
      )
    case TARGET.chat:
      return (
        firstAnswer(CHAT_RULES, { authority, target }) ?? deniedTo(refusalPath(authority.actor))
      )
  }
}
