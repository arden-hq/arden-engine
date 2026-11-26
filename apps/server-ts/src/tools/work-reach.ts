import { ACTOR, rootOf, type RunAuthority } from "../execution/authority.js"
import { boundary, VERDICT, WORK_REACH, type Path } from "../execution/decide.js"
import { AutomationId } from "../persistence/automations/model.js"

export const WORK_TARGET = { job: "job", space: "space", chat: "chat" } as const

export type WorkTarget =
  | {
      readonly kind: typeof WORK_TARGET.job
      readonly automationId: AutomationId
      readonly spaceId: string | undefined
    }
  | { readonly kind: typeof WORK_TARGET.space; readonly spaceId: string }
  | { readonly kind: typeof WORK_TARGET.chat; readonly sessionId: string }

export const WORK_TARGET_DECISION = { target: "target", refused: "refused" } as const

export const WORK_REFUSAL_REASON = {
  no_space: "no_space",
  outside_job_space: "outside_job_space",
  outside_delegated_space: "outside_delegated_space",
  unrecorded: "unrecorded"
} as const

type WorkRefusalReason = (typeof WORK_REFUSAL_REASON)[keyof typeof WORK_REFUSAL_REASON]

export type WorkBoundaryReason = Exclude<WorkRefusalReason, typeof WORK_REFUSAL_REASON.no_space>

export const WORK_OP = { create: "create", change: "change" } as const

export type WorkTargetOp = (typeof WORK_OP)[keyof typeof WORK_OP]

export type WorkTargetDecision =
  | { readonly kind: typeof WORK_TARGET_DECISION.target; readonly target: WorkTarget }
  | {
      readonly kind: typeof WORK_TARGET_DECISION.refused
      readonly reason: typeof WORK_REFUSAL_REASON.no_space
    }
  | {
      readonly kind: typeof WORK_TARGET_DECISION.refused
      readonly reason: WorkBoundaryReason
      readonly instead: ReadonlyArray<Path>
    }

export const workTarget = (input: {
  readonly authority: RunAuthority
  readonly chatSpaceId: string | undefined
  readonly chatSessionId: string
  readonly requestedSpaceId: string | undefined
  readonly op: WorkTargetOp
}): WorkTargetDecision => {
  const { authority, chatSpaceId, requestedSpaceId } = input
  const verdict = boundary(authority, {
    kind: "space_work",
    requested_space_id: requestedSpaceId,
    chat_space_id: chatSpaceId,
    op: input.op
  })
  const root = rootOf(authority.actor)
  if (verdict.kind !== VERDICT.allow) {
    const instead = verdict.kind === VERDICT.deny ? verdict.instead : []
    if (root === ACTOR.unrecorded)
      return { kind: WORK_TARGET_DECISION.refused, reason: WORK_REFUSAL_REASON.unrecorded, instead }
    return {
      kind: WORK_TARGET_DECISION.refused,
      reason:
        root === ACTOR.person
          ? WORK_REFUSAL_REASON.outside_delegated_space
          : WORK_REFUSAL_REASON.outside_job_space,
      instead
    }
  }
  switch (verdict.reach) {
    case WORK_REACH.full: {
      const spaceId = requestedSpaceId ?? chatSpaceId
      return spaceId === undefined
        ? {
            kind: WORK_TARGET_DECISION.target,
            target: { kind: WORK_TARGET.chat, sessionId: input.chatSessionId }
          }
        : { kind: WORK_TARGET_DECISION.target, target: { kind: WORK_TARGET.space, spaceId } }
    }
    case WORK_REACH.delegate:
      return spaceTarget(requestedSpaceId ?? authority.owns.space_id ?? chatSpaceId)
    case WORK_REACH.job:
    case undefined: {
      const owner = authority.owns.automation_id
      if (owner === null)
        return {
          kind: WORK_TARGET_DECISION.refused,
          reason: WORK_REFUSAL_REASON.unrecorded,
          instead: [{ kind: "report" }]
        }
      return {
        kind: WORK_TARGET_DECISION.target,
        target: {
          kind: WORK_TARGET.job,
          automationId: AutomationId.make(owner),
          spaceId: requestedSpaceId === chatSpaceId ? undefined : requestedSpaceId
        }
      }
    }
  }
}

const spaceTarget = (spaceId: string | undefined): WorkTargetDecision =>
  spaceId === undefined
    ? { kind: WORK_TARGET_DECISION.refused, reason: WORK_REFUSAL_REASON.no_space }
    : { kind: WORK_TARGET_DECISION.target, target: { kind: WORK_TARGET.space, spaceId } }
