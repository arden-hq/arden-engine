import { expect, it } from "vitest"
import {
  HOME_OFFER_SOURCES,
  OFFER_NEEDS_ANCHOR,
  offerAnchorRefusal,
  storedOfferStands
} from "../src/persistence/sqlite/offer-rules.js"

it("an offer is anchored by a chat turn or Task; a mail item only in a Space; a Memory page never", () => {
  expect(offerAnchorRefusal("space", [{ kind: "connection_item" }])).toBeUndefined()
  expect(offerAnchorRefusal("home", [{ kind: "task" }])).toBeUndefined()
  expect(offerAnchorRefusal("home", [{ kind: "connection_item" }])).toBe(HOME_OFFER_SOURCES)
  expect(offerAnchorRefusal("space", [{ kind: "memory" }])).toBe(OFFER_NEEDS_ANCHOR)
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
})
