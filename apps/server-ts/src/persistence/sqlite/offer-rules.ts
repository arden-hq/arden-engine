import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import type { SpaceTaskSource } from "@arden-hq/protocol/spaces/work"
import type { ProposalRow } from "./task-proposals.js"

// The rules that decide whether a task offer is made, stays, or comes back. Each is a pure
// function so the store and the replay over real history run the same rule.

/**
 * An offer nobody answered stops waiting this many hours after it was last offered or
 * revised. From the owner's answered offers up to 14 November 2026: every accepted offer was
 * answered within 35 hours, and 26 of 28 answers came within 48 hours; the two later answers
 * were both a No.
 */
export const OFFER_EXPIRY_HOURS = 48

/**
 * A cited chat turn is usable evidence once it has finished: it is recorded, and no run of
 * that turn is still active. What came after it in the chat, such as a Task or helper result,
 * does not matter; an owner turn that came after it changes the review's snapshot instead.
 */
export const citedTurnFinished = (runStatuses: ReadonlyArray<string>): boolean =>
  runStatuses.length > 0 && !runStatuses.some(isActiveRunStatus)

export const UNFINISHED_TURN =
  "That chat turn has not finished, or is not a turn of one of your chats; wait for its outcome and review again"

const anchors = (kind: SpaceTaskSource["kind"]): boolean => {
  switch (kind) {
    case "chat":
    case "connection_item":
    case "task":
      return true
    case "memory":
    case "space":
      return false
  }
}

export const OFFER_NEEDS_ANCHOR =
  "A Memory page is background, not a reason to offer a Task. Cite the chat turn or the mail item that asks for this outcome (a Task's worker may cite its own Task); if none does, offer nothing."

/** An offer cites a chat turn, a mail item, or its worker's own Task. Memory pages may only
 * support it: a page changes on any edit, so an offer built on one came back after a No. */
export const offerAnchorRefusal = (
  sources: ReadonlyArray<{ readonly kind: SpaceTaskSource["kind"] }>
): string | undefined =>
  sources.some((source) => anchors(source.kind)) ? undefined : OFFER_NEEDS_ANCHOR

/**
 * Whether the stored offer with the same identity answers a new propose call unchanged. The
 * identity is the place, the Task key and the cited records, so a No (`rejected`) and an
 * unanswered offer (`expired`) are final for it whatever revision of a cited record is cited
 * now. Only a retirement, which was the worker's call, yields to changed evidence.
 */
export const storedOfferStands = (
  stored: Pick<ProposalRow, "status" | "evidence_revision_key" | "candidate_hash"> & {
    readonly retired_evidence_key: string | null
  },
  call: { readonly evidenceKey: string; readonly candidateHash: string }
): boolean => {
  switch (stored.status) {
    case "accepted":
    case "rejected":
    case "expired":
      return true
    case "retired":
      return (
        stored.evidence_revision_key === call.evidenceKey ||
        stored.retired_evidence_key === call.evidenceKey
      )
    case "offered":
      return stored.candidate_hash === call.candidateHash
    case "held":
      return false
  }
}
