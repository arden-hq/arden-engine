import {
  actsAsPerson,
  isUserAutomation,
  rootOf,
  type Actor,
  type RunAuthority
} from "./authority.js"
import type { ApprovalMode } from "@arden-hq/protocol/permissions"
import type { ToolEffect } from "./tool-effect.js"
import type { RuleDecision } from "../persistence/permissions/rules.js"
import type { CallImpact } from "./impact.js"
import { firstAnswer, type Rung } from "./ladder.js"

export interface ToolFacts {
  readonly name: string
  readonly effect: ToolEffect
  readonly action: "read" | "write" | "execute"
  readonly changes_state: boolean
  readonly read_only_mode: "self_gated" | undefined
  readonly default_approval: "approve" | "ask"
  readonly always_ask: boolean
  readonly approval_bypass: boolean
  readonly refuse_unattended: boolean
  readonly per_call: boolean
  readonly standing: "always" | "requirement" | undefined
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

export interface LiveSettings {
  readonly state: "active" | "settling" | "revoked"
  readonly mode: ApprovalMode
  readonly rule: RuleDecision | undefined
}

type Floor = "destructive_command"

export type Target =
  | {
      readonly kind: "space_work"
      readonly requested_space_id: string | undefined
      readonly chat_space_id: string | undefined
      readonly op: "create" | "change"
    }
  | { readonly kind: "space_control" }
  | { readonly kind: "directives" }
  | { readonly kind: "chat_browse"; readonly scope: "space" | "all_spaces" }
  | {
      readonly kind: "chat"
      readonly verb: "message" | "change" | "open"
      readonly other_space: boolean
      readonly handed: boolean
    }

export type Path =
  | { readonly kind: "tool"; readonly name: string }
  | { readonly kind: "ask_user" }
  | { readonly kind: "report" }

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

export type Decision =
  | { readonly kind: "allow"; readonly by: "rule" | "mode" | "grant" | "user" | "default" }
  | {
      readonly kind: "ask"
      readonly reason: AskReason
      readonly presentation: {
        readonly helper: boolean
        readonly delivery: "pause" | "chat" | "refuse"
      }
    }
  | { readonly kind: "deny"; readonly rule: DenyRule; readonly instead: ReadonlyArray<Path> }

type Answer =
  | Exclude<Decision, { readonly kind: "ask" }>
  | { readonly kind: "ask"; readonly reason: AskReason; readonly helper: boolean }

interface CallContext {
  readonly authority: RunAuthority
  readonly live: LiveSettings
  readonly call: CallFacts
  readonly bounded: BoundaryVerdict | undefined
  readonly runRecord: boolean
  readonly helper: boolean
}

type DecisionRung = Rung<CallContext, Answer>

const allow = (by: Extract<Decision, { kind: "allow" }>["by"]): Answer => ({ kind: "allow", by })

const ask = (reason: AskReason, helper: boolean): Answer => ({ kind: "ask", reason, helper })

const revoked: DecisionRung = {
  name: "revoked",
  answer: ({ live }) => (live.state === "revoked" ? deny("revoked", []) : undefined)
}

const settling: DecisionRung = {
  name: "settling",
  answer: ({ live, runRecord }) =>
    live.state === "settling" && !runRecord ? deny("settling", []) : undefined
}

const userNever: DecisionRung = {
  name: "user_never",
  answer: ({ live }) =>
    live.rule === "never" ? deny("user_deny", [{ kind: "ask_user" }]) : undefined
}

const destructiveFloor: DecisionRung = {
  name: "destructive_floor",
  answer: ({ call }) =>
    call.floor !== undefined ? deny("floor", [{ kind: "ask_user" }]) : undefined
}

const toolOutOfReach: DecisionRung = {
  name: "tool_out_of_reach",
  answer: ({ authority, call }) =>
    !call.available ? deny("reach", refusalPath(authority.actor)) : undefined
}

const targetOutOfBounds: DecisionRung = {
  name: "target_out_of_bounds",
  answer: ({ bounded }) =>
    bounded?.kind === "deny" ? deny("boundary", bounded.instead) : undefined
}

const ownRunRecord: DecisionRung = {
  name: "own_run_record",
  answer: ({ runRecord }) => (runRecord ? allow("rule") : undefined)
}

const readOnlyRefusesChanges: DecisionRung = {
  name: "read_only_refuses_changes",
  answer: ({ authority, live, call }) => {
    const reads =
      isRead(call.tool) || (call.tool.read_only_mode === "self_gated" && call.reads_only)
    return live.mode === "read_only" && !reads
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
    bounded?.kind === "ask" && !skipsCards(live.mode) ? ask("boundary", false) : undefined
}

const lockedImpact: DecisionRung = {
  name: "locked_impact",
  answer: ({ call }) => (call.impact.kind === "locked" ? ask("locked", false) : undefined)
}

const readOnlyMode: DecisionRung = {
  name: "read_only_mode",
  answer: ({ live, call, helper }) => {
    if (live.mode !== "read_only") return undefined
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
  answer: ({ live, helper }) => (live.rule === "ask" ? ask("override", helper) : undefined)
}

const ruleAllows: DecisionRung = {
  name: "rule_allows",
  answer: ({ live }) => (live.rule === "allow" ? allow("grant") : undefined)
}

const allowMode: DecisionRung = {
  name: "allow_mode",
  answer: ({ live }) => (live.mode === "allow" ? allow("mode") : undefined)
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
  call.tool.default_approval === "ask" ? ask("default", helper) : allow("default")

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
    runRecord: call.tool.effect === "run_record",
    helper: live.mode === "safe" && !(call.requirement && call.user_only)
  }
  const answer = firstAnswer(DECISION_RUNGS, context) ?? toolDefault(context)
  if (answer.kind !== "ask") return answer
  if (call.approved) return { kind: "allow", by: "user" }
  return {
    kind: "ask",
    reason: answer.reason,
    presentation: { helper: answer.helper, delivery: delivery(authority, call) }
  }
}

const delivery = (authority: RunAuthority, call: CallFacts): "pause" | "chat" | "refuse" => {
  if (authority.unattended) return call.tool.refuse_unattended ? "refuse" : "chat"
  return authority.actor.kind === "agent" && !call.tool.refuse_unattended ? "chat" : "pause"
}

const settledByImpact = (mode: ApprovalMode, impact: CallImpact): boolean =>
  impact.kind === "inert" || (impact.kind === "contained" && mode === "safe")

export const skipsCards = (mode: ApprovalMode): boolean => mode === "allow"

export const waivesRequirement = (
  mode: ApprovalMode,
  tool: { readonly approval_bypass?: boolean; readonly always_ask?: boolean }
): boolean => skipsCards(mode) && tool.approval_bypass === true && tool.always_ask !== true

export type PersonCardOutcome = "ask" | "never_ask" | "read_only"

export const personCard = (mode: ApprovalMode): PersonCardOutcome => {
  if (mode === "read_only") return "read_only"
  return skipsCards(mode) ? "never_ask" : "ask"
}

export const boundaryReach = (
  authority: RunAuthority,
  target: Target,
  input: { readonly mode: ApprovalMode; readonly approved: boolean }
): "allow" | "ask" | "deny" => {
  const verdict = boundary(authority, target)
  if (verdict.kind !== "ask") return verdict.kind
  return input.approved || skipsCards(input.mode) ? "allow" : "ask"
}

const standingChange = (call: CallFacts): boolean =>
  call.tool.standing === "always" || (call.tool.standing === "requirement" && call.requirement)

const isRead = (tool: ToolFacts): boolean => tool.action === "read" && !tool.changes_state

const deny = (
  rule: DenyRule,
  instead: ReadonlyArray<Path>
): Extract<Decision, { kind: "deny" }> => ({
  kind: "deny",
  rule,
  instead
})

export const refusalPath = (actor: Actor): ReadonlyArray<Path> => {
  switch (actor.kind) {
    case "person":
      return [{ kind: "ask_user" }]
    case "agent":
      return [{ kind: "report" }]
    case "automation":
      return [{ kind: "ask_user" }, { kind: "report" }]
    case "task_worker":
      return [{ kind: "tool", name: "task_comment" }, { kind: "ask_user" }, { kind: "report" }]
    case "space_review":
    case "unrecorded":
      return [{ kind: "report" }]
  }
}

type WorkReach = "full" | "job" | "delegate"

export type BoundaryVerdict =
  | { readonly kind: "allow"; readonly reach: WorkReach | undefined }
  | { readonly kind: "ask" }
  | { readonly kind: "deny"; readonly instead: ReadonlyArray<Path> }

const ALLOW: BoundaryVerdict = { kind: "allow", reach: undefined }

const deniedTo = (instead: ReadonlyArray<Path>): BoundaryVerdict => ({ kind: "deny", instead })

interface BoundaryInput<Kind extends Target["kind"]> {
  readonly authority: RunAuthority
  readonly target: Extract<Target, { kind: Kind }>
}

type BoundaryRule<Kind extends Target["kind"]> = Rung<BoundaryInput<Kind>, BoundaryVerdict>

const ownSpaceOrChatSpace = ({ authority, target }: BoundaryInput<"space_work">) =>
  authority.owns.space_id ?? target.chat_space_id

const namesAnotherSpace = (input: BoundaryInput<"space_work">): boolean => {
  const own = ownSpaceOrChatSpace(input)
  const requested = input.target.requested_space_id
  return requested !== undefined && own !== undefined && requested !== own
}

const personReachesEverySpace: BoundaryRule<"space_work"> = {
  name: "person_reaches_every_space",
  answer: ({ authority }) =>
    actsAsPerson(authority.actor) ? { kind: "allow", reach: "full" } : undefined
}

const unrecordedOnlyReports: BoundaryRule<"space_work"> = {
  name: "unrecorded_only_reports",
  answer: ({ authority }) =>
    rootOf(authority.actor) === "unrecorded" ? deniedTo([{ kind: "report" }]) : undefined
}

const onlyPersonStartsTasks: BoundaryRule<"space_work"> = {
  name: "only_person_starts_tasks",
  answer: ({ authority, target }) =>
    target.op === "create" ? deniedTo(refusalPath(authority.actor)) : undefined
}

const personsAgentKeepsGrantedSpace: BoundaryRule<"space_work"> = {
  name: "persons_agent_keeps_granted_space",
  answer: (input) => {
    if (rootOf(input.authority.actor) !== "person") return undefined
    return namesAnotherSpace(input)
      ? deniedTo([{ kind: "report" }])
      : { kind: "allow", reach: "delegate" }
  }
}

const jobKeepsToOwnSpace: BoundaryRule<"space_work"> = {
  name: "job_keeps_to_own_space",
  answer: (input) =>
    namesAnotherSpace(input) && input.target.op === "change"
      ? deniedTo(refusalPath(input.authority.actor))
      : undefined
}

const SPACE_WORK_RULES: ReadonlyArray<BoundaryRule<"space_work">> = [
  personReachesEverySpace,
  unrecordedOnlyReports,
  onlyPersonStartsTasks,
  personsAgentKeepsGrantedSpace,
  jobKeepsToOwnSpace
]

const JOB_REACH: BoundaryVerdict = { kind: "allow", reach: "job" }

const personOnlyControl = (authority: RunAuthority): BoundaryVerdict =>
  actsAsPerson(authority.actor) ? ALLOW : deniedTo([{ kind: "ask_user" }])

const personBrowsesEveryChat: BoundaryRule<"chat_browse"> = {
  name: "person_browses_every_chat",
  answer: ({ authority }) => (actsAsPerson(authority.actor) ? ALLOW : undefined)
}

const anyoneBrowsesOwnSpace: BoundaryRule<"chat_browse"> = {
  name: "anyone_browses_own_space",
  answer: ({ target }) => (target.scope === "space" ? ALLOW : undefined)
}

const spaceReviewReadsEveryChat: BoundaryRule<"chat_browse"> = {
  name: "space_review_reads_every_chat",
  answer: ({ authority }) => (rootOf(authority.actor) === "space_review" ? ALLOW : undefined)
}

const CHAT_BROWSE_RULES: ReadonlyArray<BoundaryRule<"chat_browse">> = [
  personBrowsesEveryChat,
  anyoneBrowsesOwnSpace,
  spaceReviewReadsEveryChat
]

const sameSpaceChat: BoundaryRule<"chat"> = {
  name: "same_space_chat",
  answer: ({ target }) => (!target.other_space ? ALLOW : undefined)
}

const userAutomationActsAsPerson: BoundaryRule<"chat"> = {
  name: "user_automation_acts_as_person",
  answer: ({ authority, target }) =>
    isUserAutomation(authority.actor) && target.verb !== "open" ? ALLOW : undefined
}

const personMessagesAnotherSpace: BoundaryRule<"chat"> = {
  name: "person_messages_another_space",
  answer: ({ authority, target }) => {
    if (authority.actor.kind !== "person" || target.verb !== "message") return undefined
    return target.handed ? ALLOW : { kind: "ask" }
  }
}

const personOpensAnyChat: BoundaryRule<"chat"> = {
  name: "person_opens_any_chat",
  answer: ({ authority, target }) =>
    authority.actor.kind === "person" && target.verb === "open" ? ALLOW : undefined
}

const CHAT_RULES: ReadonlyArray<BoundaryRule<"chat">> = [
  sameSpaceChat,
  userAutomationActsAsPerson,
  personMessagesAnotherSpace,
  personOpensAnyChat
]

export const boundary = (authority: RunAuthority, target: Target): BoundaryVerdict => {
  switch (target.kind) {
    case "space_work":
      return firstAnswer(SPACE_WORK_RULES, { authority, target }) ?? JOB_REACH
    case "space_control":
    case "directives":
      return personOnlyControl(authority)
    case "chat_browse":
      return (
        firstAnswer(CHAT_BROWSE_RULES, { authority, target }) ??
        deniedTo([{ kind: "tool", name: "session_read" }])
      )
    case "chat":
      return (
        firstAnswer(CHAT_RULES, { authority, target }) ?? deniedTo(refusalPath(authority.actor))
      )
  }
}
