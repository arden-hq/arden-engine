import {
  meetCapabilities,
  type SessionResourceReach,
  type RunPolicy
} from "../../execution/policy.js"

export const intersectGoogleAccounts = (
  left: RunPolicy["google_accounts"],
  right: RunPolicy["google_accounts"]
): RunPolicy["google_accounts"] => {
  if (left === null) return right
  if (right === null) return left
  return left.filter((grant) =>
    right.some(
      (allowed) => allowed.account_id === grant.account_id && allowed.service === grant.service
    )
  )
}

export const intersectResourceSessions = (
  current: ReadonlyArray<SessionResourceReach>,
  previous: ReadonlyArray<SessionResourceReach>
): ReadonlyArray<SessionResourceReach> =>
  current.flatMap((resource) => {
    const held = previous.find(
      (candidate) =>
        candidate.session_id === resource.session_id &&
        candidate.generation === resource.generation &&
        candidate.authority_session_id === resource.authority_session_id &&
        candidate.authority_generation === resource.authority_generation
    )
    return held === undefined
      ? []
      : [
          {
            ...resource,
            capabilities: meetCapabilities(resource.capabilities, held.capabilities)
          }
        ]
  })
