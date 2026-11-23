import { expect, it } from "vitest"
import {
  OFFER_NEEDS_ANCHOR,
  offerAnchorRefusal,
  storedOfferStands
} from "../src/persistence/sqlite/offer-rules.js"

it("an offer is anchored by a chat turn, a Task or a mail item; a Memory page never", () => {
  expect(offerAnchorRefusal([{ kind: "connection_item" }])).toBeUndefined()
  expect(offerAnchorRefusal([{ kind: "task" }])).toBeUndefined()
  expect(offerAnchorRefusal([{ kind: "chat" }])).toBeUndefined()
  expect(offerAnchorRefusal([{ kind: "memory" }])).toBe(OFFER_NEEDS_ANCHOR)
})

it("a stored No stays when a cited page changed; a retired or open offer does not", () => {
  const stored = (status: Parameters<typeof storedOfferStands>[0]["status"]) => ({
    status,
    evidence_revision_key: "evidence-a",
    retired_evidence_key: null,
    candidate_hash: "candidate-a"
  })
  const changed = { evidenceKey: "evidence-b", candidateHash: "candidate-b" }
  for (const status of ["rejected", "expired", "accepted"] as const)
    expect(storedOfferStands(stored(status), changed)).toBe(true)
  for (const status of ["retired", "offered"] as const)
    expect(storedOfferStands(stored(status), changed)).toBe(false)
  expect(
    storedOfferStands(
      { ...stored("retired"), retired_evidence_key: "evidence-b" },
      { evidenceKey: "evidence-b", candidateHash: "candidate-b" }
    )
  ).toBe(true)
  expect(
    storedOfferStands(stored("retired"), {
      evidenceKey: "evidence-a",
      candidateHash: "candidate-b"
    })
  ).toBe(true)
})
