import { AGENT_MODE } from "@arden-hq/protocol/chat"
import { RUN_ORIGIN } from "@arden-hq/protocol/runs"
import { type RunContext } from "../persistence/runs/stored-context.js"
import { SYSTEM_HANDLER } from "../persistence/automations/model.js"
import { Effect, Schema } from "effect"
import { originChainDepth } from "../persistence/automations/chain-depth.js"
import {
  APPROVAL_SOURCE,
  ApprovalSourceSchema,
  stricterSource,
  type ApprovalSource
} from "./approval-source.js"
import {
  isUserAutomationPurpose,
  JOB_PURPOSE,
  JobPurposeSchema,
  type JobPurpose
} from "../persistence/job-classification.js"
import {
  RUN_CAPABILITY,
  RunCapabilitySchema,
  TOOL_SCOPE_KEY,
  SessionResourceReachSchema,
  runAuthorityChat,
  type RunCapability,
  type SessionResourceReach,
  type RunPolicy,
  type ToolScopeKey
} from "./policy.js"

const Id = Schema.NonEmptyString

const AgentModeSchema = Schema.Literals([AGENT_MODE.code, AGENT_MODE.research, AGENT_MODE.work])

export const ACTOR = {
  person: "person",
  automation: "automation",
  taskWorker: "task_worker",
  spaceReview: "space_review",
  agent: "agent",
  unrecorded: "unrecorded"
} as const

const RootKindSchema = Schema.Literals([
  ACTOR.person,
  ACTOR.automation,
  ACTOR.taskWorker,
  ACTOR.spaceReview,
  ACTOR.unrecorded
])
export type RootKind = typeof RootKindSchema.Type

const ActorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(ACTOR.person), session_id: Id, turn_id: Id }),
  Schema.Struct({
    kind: Schema.Literal(ACTOR.automation),
    automation_id: Id,
    purpose: JobPurposeSchema,
    handler: Schema.NullOr(Id)
  }),
  Schema.Struct({
    kind: Schema.Literal(ACTOR.taskWorker),
    item_id: Id,
    space_id: Schema.NullOr(Id)
  }),
  Schema.Struct({ kind: Schema.Literal(ACTOR.spaceReview), space_id: Id }),
  Schema.Struct({
    kind: Schema.Literal(ACTOR.agent),
    mode: AgentModeSchema,
    parent_run_id: Id,
    root: RootKindSchema
  }),
  Schema.Struct({ kind: Schema.Literal(ACTOR.unrecorded) })
])
export type Actor = typeof ActorSchema.Type

export const SANDBOX = { hostApproved: "host_approved", codeAgent: "code_agent" } as const

const SandboxSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(SANDBOX.hostApproved) }),
  Schema.Struct({ kind: Schema.Literal(SANDBOX.codeAgent), root: Schema.NullOr(Id) })
])
export type Sandbox = typeof SandboxSchema.Type

export const MEMORY_AUTHORITY = {
  global: "Global",
  capture: "Capture",
  space: "Space",
  none: "None"
} as const

const MemoryAuthoritySchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal(MEMORY_AUTHORITY.global) }),
  Schema.Struct({ _tag: Schema.Literal(MEMORY_AUTHORITY.capture) }),
  Schema.Struct({ _tag: Schema.Literal(MEMORY_AUTHORITY.space), space_id: Id }),
  Schema.Struct({ _tag: Schema.Literal(MEMORY_AUTHORITY.none) })
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

const EXECUTION_OWNER = {
  automation: "automation",
  spaceReview: "space_review",
  task: "task"
} as const

export type ExecutionOwner =
  | {
      readonly kind: typeof EXECUTION_OWNER.automation
      readonly key: string
      readonly purpose: typeof JOB_PURPOSE.userAutomation | typeof JOB_PURPOSE.system
      readonly handler: string | null
    }
  | {
      readonly kind: typeof EXECUTION_OWNER.spaceReview
      readonly key: string
      readonly spaceId: string
    }
  | {
      readonly kind: typeof EXECUTION_OWNER.task
      readonly key: string
      readonly spaceId: string | null
    }

export interface AdmissionFacts {
  readonly sessionId: string
  readonly context: RunContext
  readonly policy: RunPolicy
  readonly originOwner: ExecutionOwner | null
  readonly chatOwner: ExecutionOwner | null
  readonly resourceSessions?: ReadonlyArray<SessionResourceReach>
}

export const isUserAutomation = (
  actor: Actor
): actor is Extract<Actor, { kind: typeof ACTOR.automation }> =>
  actor.kind === ACTOR.automation && isUserAutomationPurpose(actor.purpose)

export const actsAsPerson = (actor: Actor): boolean =>
  actor.kind === ACTOR.person || isUserAutomation(actor)

export const rootOf = (actor: Actor): RootKind =>
  actor.kind === ACTOR.agent ? actor.root : actor.kind

export const deriveAuthority = (facts: AdmissionFacts): RunAuthority => {
  const actor = rootActor(facts)
  const permissionOwner = facts.chatOwner ?? facts.originOwner
  const resourceSessions = facts.resourceSessions ?? facts.policy.resource_sessions ?? []
  const follows = resourceSessions.reduce<ApprovalSource>(
    (held, resource) =>
      stricterSource(
        stricterSource(held, { kind: APPROVAL_SOURCE.chat, session_id: resource.session_id }),
        {
          kind: APPROVAL_SOURCE.chat,
          session_id: resource.authority_session_id
        }
      ),
    approvalSource(facts.sessionId, facts.policy, permissionOwner)
  )
  return {
    version: 1,
    actor,
    owns: {
      session_id: facts.sessionId,
      space_id: facts.policy.space?.space_id ?? null,
      automation_id:
        actor.kind === ACTOR.person || actor.kind === ACTOR.unrecorded
          ? null
          : (facts.originOwner?.key ?? facts.chatOwner?.key ?? null),
      chain_depth: originChainDepth(facts.context.origin),
      task_item_id: facts.context.task?.item_id ?? null
    },
    reach: {
      capabilities: facts.policy.capabilities,
      observe: facts.policy.execution.observe,
      resource_sessions: resourceSessions
    },
    approval: { follows },
    sandbox: { kind: SANDBOX.hostApproved },
    memory: memoryOf(actor, facts.policy),
    delegation: { depth: 0, chain: [] },
    unattended: actor.kind !== ACTOR.person
  }
}

const rootActor = (facts: AdmissionFacts): Actor => {
  const origin = facts.context.origin
  switch (origin.kind) {
    case RUN_ORIGIN.chat:
      return { kind: ACTOR.person, session_id: origin.session_id, turn_id: origin.turn_id }
    case RUN_ORIGIN.automation:
      return {
        kind: ACTOR.automation,
        automation_id: origin.automation_id,
        ...automationActorFacts(facts.originOwner)
      }
    case RUN_ORIGIN.task:
      return {
        kind: ACTOR.taskWorker,
        item_id: origin.item_id,
        space_id: facts.policy.space?.space_id ?? null
      }
    case RUN_ORIGIN.space:
      return { kind: ACTOR.spaceReview, space_id: origin.space_id }
    case RUN_ORIGIN.unrecorded:
      return { kind: ACTOR.unrecorded }
  }
}

const automationActorFacts = (
  owner: ExecutionOwner | null
): { readonly purpose: JobPurpose; readonly handler: string | null } => {
  if (owner === null) return { purpose: JOB_PURPOSE.userAutomation, handler: null }
  switch (owner.kind) {
    case EXECUTION_OWNER.automation:
      return { purpose: owner.purpose, handler: owner.handler }
    case EXECUTION_OWNER.spaceReview:
      return { purpose: JOB_PURPOSE.spaceReview, handler: null }
    case EXECUTION_OWNER.task:
      return { purpose: JOB_PURPOSE.taskExecution, handler: null }
  }
}

const approvalSource = (
  sessionId: string,
  policy: RunPolicy,
  owner: ExecutionOwner | null
): ApprovalSource => {
  if (owner === null) {
    const current: ApprovalSource = { kind: APPROVAL_SOURCE.chat, session_id: sessionId }
    const authority = runAuthorityChat(policy, sessionId)
    return authority === sessionId
      ? current
      : stricterSource(current, { kind: APPROVAL_SOURCE.chat, session_id: authority })
  }
  switch (owner.kind) {
    case EXECUTION_OWNER.automation:
      return isUserAutomationPurpose(owner.purpose)
        ? { kind: APPROVAL_SOURCE.chat, session_id: runAuthorityChat(policy, sessionId) }
        : { kind: APPROVAL_SOURCE.automation, automation_id: owner.key }
    case EXECUTION_OWNER.spaceReview:
      return { kind: APPROVAL_SOURCE.space_thread, space_id: owner.spaceId }
    case EXECUTION_OWNER.task:
      return owner.spaceId === null
        ? { kind: APPROVAL_SOURCE.automation, automation_id: owner.key }
        : { kind: APPROVAL_SOURCE.space_thread, space_id: owner.spaceId }
  }
}

const memoryOf = (actor: Actor, policy: RunPolicy): MemoryAuthority => {
  switch (actor.kind) {
    case ACTOR.person:
      return { _tag: MEMORY_AUTHORITY.global }
    case ACTOR.automation:
      return actor.handler === SYSTEM_HANDLER.memoryCapture
        ? { _tag: MEMORY_AUTHORITY.capture }
        : { _tag: MEMORY_AUTHORITY.global }
    case ACTOR.spaceReview:
      return { _tag: MEMORY_AUTHORITY.space, space_id: actor.space_id }
    case ACTOR.taskWorker:
      return policy.space === null
        ? { _tag: MEMORY_AUTHORITY.none }
        : { _tag: MEMORY_AUTHORITY.space, space_id: policy.space.space_id }
    case ACTOR.agent:
    case ACTOR.unrecorded:
      return { _tag: MEMORY_AUTHORITY.none }
  }
}

export const unrecordedAuthority = (sessionId: string): RunAuthority => ({
  version: 1,
  actor: { kind: ACTOR.unrecorded },
  owns: {
    session_id: sessionId,
    space_id: null,
    automation_id: null,
    chain_depth: 0,
    task_item_id: null
  },
  reach: { capabilities: [RUN_CAPABILITY.readOnly], observe: false, resource_sessions: [] },
  approval: { follows: { kind: APPROVAL_SOURCE.chat, session_id: sessionId } },
  sandbox: { kind: SANDBOX.hostApproved },
  memory: { _tag: MEMORY_AUTHORITY.none },
  delegation: { depth: 0, chain: [] },
  unattended: true
})

export const authorityScopes = (
  authority: RunAuthority
): readonly [ToolScopeKey, ...Array<ToolScopeKey>] => [
  ...authority.reach.capabilities,
  ...(actsAsPerson(authority.actor) ? [] : [TOOL_SCOPE_KEY.worker]),
  ...(authority.reach.observe ? [TOOL_SCOPE_KEY.observer] : [])
]

export const sharedResourceSessions = (
  authority: RunAuthority,
  capability: RunCapability
): ReadonlyArray<SessionResourceReach> =>
  (authority.reach.resource_sessions ?? []).filter(
    (resource) =>
      resource.capabilities.includes(RUN_CAPABILITY.all) ||
      resource.capabilities.includes(capability)
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
