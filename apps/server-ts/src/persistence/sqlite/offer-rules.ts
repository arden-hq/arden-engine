import { TASK_PROPOSAL_STATUS } from "@arden-hq/protocol/proposals"
import { SOURCE_KIND } from "@arden-hq/protocol/spaces/work"
import type { TaskSourceRecord } from "../work/task-record.js"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import type { ProposalRow } from "./task-proposal-support.js"

export const OFFER_EXPIRY_HOURS = 48

export const OFFER_LATER_HOURS = 24

export const citedTurnFinished = (runStatuses: ReadonlyArray<string>): boolean =>
  runStatuses.length > 0 && !runStatuses.some(isActiveRunStatus)

export const UNFINISHED_TURN =
  "That chat turn has not finished, or is not a turn of one of your chats; wait for its outcome and review again"

const anchors = (kind: TaskSourceRecord["kind"]): boolean => {
  switch (kind) {
    case SOURCE_KIND.chat:
    case SOURCE_KIND.task:
    case SOURCE_KIND.connection_item:
      return true
    case SOURCE_KIND.memory:
    case SOURCE_KIND.space:
      return false
  }
}

export const OFFER_NEEDS_ANCHOR =
  "A Memory page is background, not a reason to offer a Task. Cite the chat turn or the mail item that asks for this outcome (a Task's worker may cite its own Task); if none does, offer nothing."

export const offerAnchorRefusal = (
  sources: ReadonlyArray<{ readonly kind: TaskSourceRecord["kind"] }>
): string | undefined =>
  sources.some((source) => anchors(source.kind)) ? undefined : OFFER_NEEDS_ANCHOR

export const storedOfferStands = (
  stored: Pick<ProposalRow, "status" | "evidence_revision_key" | "candidate_hash"> & {
    readonly retired_evidence_key: string | null
  },
  call: { readonly evidenceKey: string; readonly candidateHash: string }
): boolean => {
  switch (stored.status) {
    case TASK_PROPOSAL_STATUS.accepted:
    case TASK_PROPOSAL_STATUS.rejected:
    case TASK_PROPOSAL_STATUS.expired:
      return true
    case TASK_PROPOSAL_STATUS.retired:
      return (
        stored.evidence_revision_key === call.evidenceKey ||
        stored.retired_evidence_key === call.evidenceKey
      )
    case TASK_PROPOSAL_STATUS.offered:
      return stored.candidate_hash === call.candidateHash
    case TASK_PROPOSAL_STATUS.held:
      return false
  }
}
