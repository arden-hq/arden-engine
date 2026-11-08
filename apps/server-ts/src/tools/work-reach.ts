import { rootOf, type RunAuthority } from "../execution/authority.js"
import { boundary, type Path } from "../execution/decide.js"
import { AutomationId } from "../persistence/automations/model.js"

export type WorkTarget =
  | {
      readonly kind: "job"
      readonly automationId: AutomationId
      readonly spaceId: string | undefined
    }
  | { readonly kind: "space"; readonly spaceId: string }
  | { readonly kind: "chat"; readonly sessionId: string }

export type WorkTargetDecision =
  | { readonly kind: "target"; readonly target: WorkTarget }
  | { readonly kind: "refused"; readonly reason: "no_space" }
  | {
      readonly kind: "refused"
      readonly reason: "outside_job_space" | "outside_delegated_space" | "unrecorded"
      readonly instead: ReadonlyArray<Path>
    }

export const workTarget = (input: {
  readonly authority: RunAuthority
  readonly chatSpaceId: string | undefined
  readonly chatSessionId: string
  readonly requestedSpaceId: string | undefined
  readonly op: "create" | "change"
}): WorkTargetDecision => {
  const { authority, chatSpaceId, requestedSpaceId } = input
  const verdict = boundary(authority, {
    kind: "space_work",
    requested_space_id: requestedSpaceId,
    chat_space_id: chatSpaceId,
    op: input.op
  })
  const root = rootOf(authority.actor)
  if (verdict.kind !== "allow") {
    const instead = verdict.kind === "deny" ? verdict.instead : []
    if (root === "unrecorded") return { kind: "refused", reason: "unrecorded", instead }
    return {
      kind: "refused",
      reason: root === "person" ? "outside_delegated_space" : "outside_job_space",
      instead
    }
  }
  switch (verdict.reach) {
    case "full": {
      const spaceId = requestedSpaceId ?? chatSpaceId
      return spaceId === undefined
        ? { kind: "target", target: { kind: "chat", sessionId: input.chatSessionId } }
        : { kind: "target", target: { kind: "space", spaceId } }
    }
    case "delegate":
      return spaceTarget(requestedSpaceId ?? authority.owns.space_id ?? chatSpaceId)
    case "job":
    case undefined: {
      const owner = authority.owns.automation_id
      if (owner === null)
        return { kind: "refused", reason: "unrecorded", instead: [{ kind: "report" }] }
      return {
        kind: "target",
        target: {
          kind: "job",
          automationId: AutomationId.make(owner),
          spaceId: requestedSpaceId === chatSpaceId ? undefined : requestedSpaceId
        }
      }
    }
  }
}

const spaceTarget = (spaceId: string | undefined): WorkTargetDecision =>
  spaceId === undefined
    ? { kind: "refused", reason: "no_space" }
    : { kind: "target", target: { kind: "space", spaceId } }
