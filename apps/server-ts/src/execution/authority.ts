import { isWithin } from "@arden-hq/std/paths"
import type { RunContext } from "@arden-hq/protocol/runs"
import { Effect, Schema } from "effect"
import {
  isUserAutomationPurpose,
  JobPurposeSchema,
  type JobPurpose
} from "../persistence/job-classification.js"
import {
  RunCapabilitySchema,
  SessionResourceReachSchema,
  meetCapabilities,
  narrowCapabilities,
  type RunCapability,
  type SessionResourceReach,
  type RunPolicy,
  type ToolScopeKey
} from "./policy.js"

const Id = Schema.NonEmptyString

const AgentModeSchema = Schema.Literals(["code", "research", "work"])
type AgentMode = typeof AgentModeSchema.Type

const RootKindSchema = Schema.Literals([
  "person",
  "automation",
  "task_worker",
  "space_review",
  "unrecorded"
])
export type RootKind = typeof RootKindSchema.Type

const ActorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("person"), session_id: Id, turn_id: Id }),
  Schema.Struct({
    kind: Schema.Literal("automation"),
    automation_id: Id,
    purpose: JobPurposeSchema,
    handler: Schema.NullOr(Id)
  }),
  Schema.Struct({ kind: Schema.Literal("task_worker"), item_id: Id, space_id: Schema.NullOr(Id) }),
  Schema.Struct({ kind: Schema.Literal("space_review"), space_id: Id }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    mode: AgentModeSchema,
    parent_run_id: Id,
    root: RootKindSchema
  }),
  Schema.Struct({ kind: Schema.Literal("unrecorded") })
])
export type Actor = typeof ActorSchema.Type

const SingleApprovalSourceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("chat"), session_id: Id }),
  Schema.Struct({ kind: Schema.Literal("space_thread"), space_id: Id }),
  Schema.Struct({ kind: Schema.Literal("automation"), automation_id: Id })
])
export type SingleApprovalSource = typeof SingleApprovalSourceSchema.Type

const ApprovalSourceSchema = Schema.Union([
  ...SingleApprovalSourceSchema.members,
  Schema.Struct({
    kind: Schema.Literal("stricter"),
    of: Schema.Array(SingleApprovalSourceSchema).check(Schema.isMinLength(2))
  })
])
export type ApprovalSource = typeof ApprovalSourceSchema.Type

export const approvalSources = (source: ApprovalSource): ReadonlyArray<SingleApprovalSource> =>
  source.kind === "stricter" ? source.of : [source]

const sameSource = (left: SingleApprovalSource, right: SingleApprovalSource) =>
  JSON.stringify(left) === JSON.stringify(right)

const stricterSource = (left: ApprovalSource, right: ApprovalSource): ApprovalSource => {
  const of = [...approvalSources(left)]
  for (const source of approvalSources(right))
    if (!of.some((held) => sameSource(held, source))) of.push(source)
  const [only] = of
  return of.length === 1 && only !== undefined ? only : { kind: "stricter", of }
}

const SandboxSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("host_approved") }),
  Schema.Struct({ kind: Schema.Literal("code_agent"), root: Schema.NullOr(Id) })
])
type Sandbox = typeof SandboxSchema.Type

const MemoryAuthoritySchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Global") }),
  Schema.Struct({ _tag: Schema.Literal("Capture") }),
  Schema.Struct({ _tag: Schema.Literal("Space"), space_id: Id }),
  Schema.Struct({ _tag: Schema.Literal("None") })
])
export type MemoryAuthority = typeof MemoryAuthoritySchema.Type

export const RunAuthoritySchema = Schema.Struct({
  version: Schema.Literal(1),
  actor: ActorSchema,
  owns: Schema.Struct({
    session_id: Id,
    space_id: Schema.NullOr(Id),
    automation_id: Schema.NullOr(Id),
    chain_depth: Schema.Natural.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
    task_item_id: Schema.NullOr(Id)
  }),
  reach: Schema.Struct({
    capabilities: Schema.NonEmptyArray(RunCapabilitySchema),
    observe: Schema.Boolean,
    resource_sessions: Schema.optionalKey(Schema.Array(SessionResourceReachSchema))
  }),
  approval: Schema.Struct({ follows: ApprovalSourceSchema }),
  sandbox: SandboxSchema,
  memory: MemoryAuthoritySchema,
  delegation: Schema.Struct({ depth: Schema.Natural, chain: Schema.Array(Id) }),
  unattended: Schema.Boolean
})
export type RunAuthority = typeof RunAuthoritySchema.Type

export interface AutomationFacts {
  readonly automation_id: string
  readonly purpose: JobPurpose
  readonly handler: string | null
  readonly owner_space_id: string | null
}

export interface AdmissionFacts {
  readonly sessionId: string
  readonly context: RunContext
  readonly policy: RunPolicy
  readonly originAutomation: AutomationFacts | null
  readonly chatAutomation: AutomationFacts | null
  readonly resourceSessions?: ReadonlyArray<SessionResourceReach>
}

export type AgentRequest = {
  readonly mode: AgentMode
  readonly sessionId: string
  readonly parentRunId: string
  readonly workspaceRoot: string | null
  readonly taskItemId: string | null
}

export const isUserAutomation = (actor: Actor): actor is Extract<Actor, { kind: "automation" }> =>
  actor.kind === "automation" && isUserAutomationPurpose(actor.purpose)

export const actsAsPerson = (actor: Actor): boolean =>
  actor.kind === "person" || isUserAutomation(actor)

export const rootOf = (actor: Actor): RootKind => (actor.kind === "agent" ? actor.root : actor.kind)

export const deriveAuthority = (facts: AdmissionFacts): RunAuthority => {
  const actor = rootActor(facts)
  const permissionOwner = facts.chatAutomation ?? facts.originAutomation
  const resourceSessions = facts.resourceSessions ?? facts.policy.resource_sessions ?? []
  const follows = resourceSessions.reduce<ApprovalSource>(
    (held, resource) =>
      stricterSource(stricterSource(held, { kind: "chat", session_id: resource.session_id }), {
        kind: "chat",
        session_id: resource.authority_session_id
      }),
    approvalSource(facts.sessionId, facts.policy, permissionOwner)
  )
  return {
    version: 1,
    actor,
    owns: {
      session_id: facts.sessionId,
      space_id: facts.policy.space?.space_id ?? null,
      automation_id:
        actor.kind === "person" || actor.kind === "unrecorded"
          ? null
          : (facts.originAutomation?.automation_id ?? facts.chatAutomation?.automation_id ?? null),
      chain_depth:
        facts.context.origin.kind === "automation" ? (facts.context.origin.chain_depth ?? 0) : 0,
      task_item_id: facts.context.task?.item_id ?? null
    },
    reach: {
      capabilities: facts.policy.capabilities,
      observe: facts.policy.execution.observe,
      resource_sessions: resourceSessions
    },
    approval: { follows },
    sandbox: { kind: "host_approved" },
    memory: memoryOf(actor, facts.policy),
    delegation: { depth: 0, chain: [] },
    unattended: actor.kind !== "person"
  }
}

const rootActor = (facts: AdmissionFacts): Actor => {
  const origin = facts.context.origin
  switch (origin.kind) {
    case "chat":
      return { kind: "person", session_id: origin.session_id, turn_id: origin.turn_id }
    case "automation":
      return {
        kind: "automation",
        automation_id: origin.automation_id,
        purpose: facts.originAutomation?.purpose ?? "user_automation",
        handler: facts.originAutomation?.handler ?? null
      }
    case "task":
      return {
        kind: "task_worker",
        item_id: origin.item_id,
        space_id: facts.policy.space?.space_id ?? null
      }
    case "space":
      return { kind: "space_review", space_id: origin.space_id }
    case "unrecorded":
      return { kind: "unrecorded" }
  }
}

const approvalSource = (
  sessionId: string,
  policy: RunPolicy,
  owner: AutomationFacts | null
): ApprovalSource => {
  if (owner === null) {
    const current: ApprovalSource = { kind: "chat", session_id: sessionId }
    return policy.authority_session_id === undefined || policy.authority_session_id === sessionId
      ? current
      : stricterSource(current, { kind: "chat", session_id: policy.authority_session_id })
  }
  if (owner.purpose === "user_automation")
    return { kind: "chat", session_id: policy.authority_session_id ?? sessionId }
  if (owner.owner_space_id !== null) return { kind: "space_thread", space_id: owner.owner_space_id }
  return { kind: "automation", automation_id: owner.automation_id }
}

const memoryOf = (actor: Actor, policy: RunPolicy): MemoryAuthority => {
  switch (actor.kind) {
    case "person":
      return { _tag: "Global" }
    case "automation":
      return actor.handler === "memory_capture" ? { _tag: "Capture" } : { _tag: "Global" }
    case "space_review":
      return { _tag: "Space", space_id: actor.space_id }
    case "task_worker":
      return policy.space === null
        ? { _tag: "None" }
        : { _tag: "Space", space_id: policy.space.space_id }
    case "agent":
    case "unrecorded":
      return { _tag: "None" }
  }
}

export const unrecordedAuthority = (sessionId: string): RunAuthority => ({
  version: 1,
  actor: { kind: "unrecorded" },
  owns: {
    session_id: sessionId,
    space_id: null,
    automation_id: null,
    chain_depth: 0,
    task_item_id: null
  },
  reach: { capabilities: ["read_only"], observe: false, resource_sessions: [] },
  approval: { follows: { kind: "chat", session_id: sessionId } },
  sandbox: { kind: "host_approved" },
  memory: { _tag: "None" },
  delegation: { depth: 0, chain: [] },
  unattended: true
})

export const orphanAgentAuthority = (request: AgentRequest): RunAuthority => ({
  version: 1,
  actor: {
    kind: "agent",
    mode: request.mode,
    parent_run_id: request.parentRunId,
    root: "unrecorded"
  },
  owns: {
    session_id: request.sessionId,
    space_id: null,
    automation_id: null,
    chain_depth: 0,
    task_item_id: request.taskItemId
  },
  reach: { capabilities: ["read_only"], observe: false, resource_sessions: [] },
  approval: { follows: { kind: "chat", session_id: request.sessionId } },
  sandbox:
    request.mode === "code"
      ? { kind: "code_agent", root: request.workspaceRoot }
      : { kind: "host_approved" },
  memory: { _tag: "None" },
  delegation: { depth: 1, chain: [request.parentRunId] },
  unattended: true
})

const AGENT_CAPABILITY = { code: "agent_code", research: "agent_research", work: "all" } as const

export type NarrowResult =
  | { readonly kind: "narrowed"; readonly authority: RunAuthority }
  | { readonly kind: "refused"; readonly reason: "observer_delegation" }

const assertWithin = (
  producer: "narrow" | "handedAuthority",
  derived: RunAuthority,
  parent: RunAuthority
): void => {
  const wider = widerAxes(derived, parent)
  if (wider.length > 0) throw new Error(`${producer}() widened ${wider.join(", ")}`)
}

export const narrow = (parent: RunAuthority, request: AgentRequest): NarrowResult => {
  if (parent.reach.observe) return { kind: "refused", reason: "observer_delegation" }
  const capabilities = narrowCapabilities(AGENT_CAPABILITY[request.mode], parent.reach.capabilities)
  const child: RunAuthority = {
    version: 1,
    actor: {
      kind: "agent",
      mode: request.mode,
      parent_run_id: request.parentRunId,
      root: rootOf(parent.actor)
    },
    owns: {
      session_id: request.sessionId,
      space_id: parent.owns.space_id,
      automation_id: parent.owns.automation_id,
      chain_depth: parent.owns.chain_depth,
      task_item_id: parent.owns.task_item_id ?? request.taskItemId
    },
    reach: {
      capabilities,
      observe: false,
      resource_sessions: narrowResourceSessions(parent.reach.resource_sessions ?? [], capabilities)
    },
    approval: parent.approval,
    sandbox: childSandbox(parent.sandbox, request),
    memory: parent.memory,
    delegation: {
      depth: parent.delegation.depth + 1,
      chain: [...parent.delegation.chain, request.parentRunId]
    },
    unattended: parent.unattended
  }
  assertWithin("narrow", child, parent)
  return { kind: "narrowed", authority: child }
}

const meetReach = (
  child: RunAuthority["reach"],
  own: RunAuthority["reach"]
): RunAuthority["reach"] => ({
  capabilities: meetCapabilities(child.capabilities, own.capabilities),
  observe: child.observe || own.observe,
  resource_sessions: meetResourceSessions(
    child.resource_sessions ?? [],
    own.resource_sessions ?? []
  )
})

const strictestSetting = (
  child: RunAuthority["approval"],
  own: RunAuthority["approval"]
): RunAuthority["approval"] => ({ follows: stricterSource(child.follows, own.follows) })

const applyChatLimit = (child: RunAuthority, own: RunAuthority): RunAuthority => ({
  ...child,
  reach: meetReach(child.reach, own.reach),
  approval: strictestSetting(child.approval, own.approval),
  memory: narrowerMemory(own.memory, child.memory),
  unattended: child.unattended || own.unattended
})

export const handedAuthority = (
  sender: RunAuthority,
  own: RunAuthority,
  request: AgentRequest
): RunAuthority => {
  const narrowed = narrow(sender, request)
  if (narrowed.kind === "refused") return orphanAgentAuthority(request)
  const handed = applyChatLimit(narrowed.authority, own)
  assertWithin("handedAuthority", handed, sender)
  return handed
}

const meetResourceSessions = (
  left: ReadonlyArray<SessionResourceReach>,
  right: ReadonlyArray<SessionResourceReach>
): ReadonlyArray<SessionResourceReach> =>
  left.flatMap((resource) => {
    const matching = right.find(
      (candidate) =>
        candidate.session_id === resource.session_id &&
        candidate.generation === resource.generation &&
        candidate.authority_session_id === resource.authority_session_id &&
        candidate.authority_generation === resource.authority_generation
    )
    return matching === undefined
      ? []
      : [
          {
            ...resource,
            capabilities: meetCapabilities(resource.capabilities, matching.capabilities)
          }
        ]
  })

const narrowResourceSessions = (
  resources: ReadonlyArray<SessionResourceReach>,
  capabilities: RunPolicy["capabilities"]
): ReadonlyArray<SessionResourceReach> =>
  resources.map((resource) => ({
    ...resource,
    capabilities: meetCapabilities(resource.capabilities, capabilities)
  }))

const childSandbox = (parent: Sandbox, request: AgentRequest): Sandbox => {
  if (request.mode !== "code") return parent
  const requested: Sandbox = { kind: "code_agent", root: request.workspaceRoot }
  return sandboxWithin(requested, parent) ? requested : parent
}

type AuthorityAxis =
  | "actor"
  | "owns"
  | "reach"
  | "approval"
  | "sandbox"
  | "memory"
  | "delegation"
  | "unattended"

export const widerAxes = (
  child: RunAuthority,
  parent: RunAuthority
): ReadonlyArray<AuthorityAxis> => {
  const checks: Record<AuthorityAxis, boolean> = {
    actor: child.actor.kind === "agent" && child.actor.root === rootOf(parent.actor),
    owns:
      child.owns.space_id === parent.owns.space_id &&
      child.owns.automation_id === parent.owns.automation_id &&
      child.owns.chain_depth === parent.owns.chain_depth &&
      (parent.owns.task_item_id === null || child.owns.task_item_id === parent.owns.task_item_id),
    reach:
      parent.reach.capabilities.every(
        (capability) => capability === "all" || child.reach.capabilities.includes(capability)
      ) &&
      (!parent.reach.observe || child.reach.observe) &&
      (child.reach.resource_sessions ?? []).every((resource) =>
        (parent.reach.resource_sessions ?? []).some(
          (held) =>
            held.session_id === resource.session_id &&
            held.generation === resource.generation &&
            held.authority_session_id === resource.authority_session_id &&
            held.authority_generation === resource.authority_generation &&
            held.capabilities.every(
              (capability) => capability === "all" || resource.capabilities.includes(capability)
            )
        )
      ),
    approval: approvalSources(parent.approval.follows).every((source) =>
      approvalSources(child.approval.follows).some((held) => sameSource(held, source))
    ),
    sandbox: sandboxWithin(child.sandbox, parent.sandbox),
    memory: memoryWithin(child.memory, parent.memory),
    delegation:
      child.delegation.depth > parent.delegation.depth &&
      parent.delegation.chain.every((runId, index) => child.delegation.chain[index] === runId),
    unattended: !parent.unattended || child.unattended
  }
  return (Object.keys(checks) as Array<AuthorityAxis>).filter((axis) => !checks[axis])
}

const sandboxWithin = (child: Sandbox, parent: Sandbox): boolean => {
  if (parent.kind === "host_approved") return true
  if (child.kind !== "code_agent") return false
  if (parent.root === null) return child.root === null
  if (child.root === null) return false
  return isWithin(parent.root, child.root)
}

const narrowerMemory = (left: MemoryAuthority, right: MemoryAuthority): MemoryAuthority => {
  if (memoryWithin(left, right)) return left
  if (memoryWithin(right, left)) return right
  return { _tag: "None" }
}

const memoryWithin = (child: MemoryAuthority, parent: MemoryAuthority): boolean => {
  switch (parent._tag) {
    case "Global":
    case "Capture":
      return true
    case "Space":
      return child._tag === "None" || (child._tag === "Space" && child.space_id === parent.space_id)
    case "None":
      return child._tag === "None"
  }
}

export const authorityScopes = (
  authority: RunAuthority
): readonly [ToolScopeKey, ...Array<ToolScopeKey>] => [
  ...authority.reach.capabilities,
  ...(actsAsPerson(authority.actor) ? [] : ["worker" as const]),
  ...(authority.reach.observe ? ["observer" as const] : [])
]

export const sharedResourceSessions = (
  authority: RunAuthority,
  capability: RunCapability
): ReadonlyArray<SessionResourceReach> =>
  (authority.reach.resource_sessions ?? []).filter(
    (resource) =>
      resource.capabilities.includes("all") || resource.capabilities.includes(capability)
  )

const TAKES_ANSWERS_MID_RUN: Record<Actor["kind"], (agentChat: boolean) => boolean> = {
  person: () => true,
  agent: (agentChat) => agentChat,
  automation: () => false,
  task_worker: () => false,
  space_review: () => false,
  unrecorded: () => false
}

export const takesAnswersMidRun = (actor: Actor, agentChat: boolean): boolean =>
  TAKES_ANSWERS_MID_RUN[actor.kind](agentChat)
