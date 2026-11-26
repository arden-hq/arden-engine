import { AGENT_MODE, type AgentMode } from "@arden-hq/protocol/chat"
import { isWithin } from "@arden-hq/std/paths"
import {
  ACTOR,
  MEMORY_AUTHORITY,
  SANDBOX,
  rootOf,
  type MemoryAuthority,
  type RunAuthority,
  type Sandbox
} from "./authority.js"
import { APPROVAL_SOURCE, approvalSources, sameSource, stricterSource } from "./approval-source.js"
import {
  RUN_CAPABILITY,
  meetCapabilities,
  narrowCapabilities,
  type RunCapability,
  type RunPolicy,
  type SessionResourceReach
} from "./policy.js"

export type AgentRequest = {
  readonly mode: AgentMode
  readonly sessionId: string
  readonly parentRunId: string
  readonly workspaceRoot: string | null
  readonly taskItemId: string | null
}

export const orphanAgentAuthority = (request: AgentRequest): RunAuthority => ({
  version: 1,
  actor: {
    kind: ACTOR.agent,
    mode: request.mode,
    parent_run_id: request.parentRunId,
    root: ACTOR.unrecorded
  },
  owns: {
    session_id: request.sessionId,
    space_id: null,
    automation_id: null,
    chain_depth: 0,
    task_item_id: request.taskItemId
  },
  reach: { capabilities: [RUN_CAPABILITY.readOnly], observe: false, resource_sessions: [] },
  approval: { follows: { kind: APPROVAL_SOURCE.chat, session_id: request.sessionId } },
  sandbox:
    request.mode === AGENT_MODE.code
      ? { kind: SANDBOX.codeAgent, root: request.workspaceRoot }
      : { kind: SANDBOX.hostApproved },
  memory: { _tag: MEMORY_AUTHORITY.none },
  delegation: { depth: 1, chain: [request.parentRunId] },
  unattended: true
})

const AGENT_CAPABILITY: Record<AgentMode, RunCapability> = {
  code: RUN_CAPABILITY.agentCode,
  research: RUN_CAPABILITY.agentResearch,
  work: RUN_CAPABILITY.all
}

const NARROW_RESULT = { narrowed: "narrowed", refused: "refused" } as const

export type NarrowResult =
  | { readonly kind: typeof NARROW_RESULT.narrowed; readonly authority: RunAuthority }
  | { readonly kind: typeof NARROW_RESULT.refused; readonly reason: "observer_delegation" }

const assertWithin = (
  producer: "narrow" | "handedAuthority",
  derived: RunAuthority,
  parent: RunAuthority
): void => {
  const wider = widerAxes(derived, parent)
  if (wider.length > 0) throw new Error(`${producer}() widened ${wider.join(", ")}`)
}

export const narrow = (parent: RunAuthority, request: AgentRequest): NarrowResult => {
  if (parent.reach.observe) return { kind: NARROW_RESULT.refused, reason: "observer_delegation" }
  const capabilities = narrowCapabilities(AGENT_CAPABILITY[request.mode], parent.reach.capabilities)
  const child: RunAuthority = {
    version: 1,
    actor: {
      kind: ACTOR.agent,
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
  return { kind: NARROW_RESULT.narrowed, authority: child }
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
  if (narrowed.kind === NARROW_RESULT.refused) return orphanAgentAuthority(request)
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
  if (request.mode !== AGENT_MODE.code) return parent
  const requested: Sandbox = { kind: SANDBOX.codeAgent, root: request.workspaceRoot }
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
    actor: child.actor.kind === ACTOR.agent && child.actor.root === rootOf(parent.actor),
    owns:
      child.owns.space_id === parent.owns.space_id &&
      child.owns.automation_id === parent.owns.automation_id &&
      child.owns.chain_depth === parent.owns.chain_depth &&
      (parent.owns.task_item_id === null || child.owns.task_item_id === parent.owns.task_item_id),
    reach:
      parent.reach.capabilities.every(
        (capability) =>
          capability === RUN_CAPABILITY.all || child.reach.capabilities.includes(capability)
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
              (capability) =>
                capability === RUN_CAPABILITY.all || resource.capabilities.includes(capability)
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
  if (parent.kind === SANDBOX.hostApproved) return true
  if (child.kind !== SANDBOX.codeAgent) return false
  if (parent.root === null) return child.root === null
  if (child.root === null) return false
  return isWithin(parent.root, child.root)
}

const narrowerMemory = (left: MemoryAuthority, right: MemoryAuthority): MemoryAuthority => {
  if (memoryWithin(left, right)) return left
  if (memoryWithin(right, left)) return right
  return { _tag: MEMORY_AUTHORITY.none }
}

const memoryWithin = (child: MemoryAuthority, parent: MemoryAuthority): boolean => {
  switch (parent._tag) {
    case MEMORY_AUTHORITY.global:
    case MEMORY_AUTHORITY.capture:
      return true
    case MEMORY_AUTHORITY.space:
      return (
        child._tag === MEMORY_AUTHORITY.none ||
        (child._tag === MEMORY_AUTHORITY.space && child.space_id === parent.space_id)
      )
    case MEMORY_AUTHORITY.none:
      return child._tag === MEMORY_AUTHORITY.none
  }
}
