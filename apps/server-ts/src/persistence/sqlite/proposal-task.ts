import { RESOLVED_PROPOSAL_TASK, type ResolveTaskProposalTask } from "@arden-hq/protocol/proposals"

export const UNSTARTED: Extract<
  ResolveTaskProposalTask,
  { readonly kind: typeof RESOLVED_PROPOSAL_TASK.unstarted }
> = { kind: RESOLVED_PROPOSAL_TASK.unstarted }
