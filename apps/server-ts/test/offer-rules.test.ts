import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  citedTurnFinished,
  OFFER_NEEDS_ANCHOR,
  offerAnchorRefusal,
  storedOfferStands
} from "../src/persistence/sqlite/offer-rules.js"

describe("a cited chat turn", () => {
  it("is usable once every run of it has ended, whatever came after it", () => {
    expect(citedTurnFinished(["completed"])).toBe(true)
    expect(citedTurnFinished(["interrupted", "completed"])).toBe(true)
  })

  it("is not usable while a run of it is active, or when it was never recorded", () => {
    expect(citedTurnFinished(["running"])).toBe(false)
    expect(citedTurnFinished(["completed", "pending"])).toBe(false)
    expect(citedTurnFinished([])).toBe(false)
  })
})

describe("an offer's anchor", () => {
  it("is a chat turn, a mail item or the worker's own Task", () => {
    expect(offerAnchorRefusal([{ kind: "chat" }])).toBeUndefined()
    expect(offerAnchorRefusal([{ kind: "connection_item" }, { kind: "memory" }])).toBeUndefined()
    expect(offerAnchorRefusal([{ kind: "task" }])).toBeUndefined()
  })

  it("is never a Memory page alone, and the refusal says what to cite without a hash", () => {
    expect(offerAnchorRefusal([{ kind: "memory" }, { kind: "memory" }])).toBe(OFFER_NEEDS_ANCHOR)
    expect(OFFER_NEEDS_ANCHOR).toMatch(/chat turn or the mail item/u)
    expect(OFFER_NEEDS_ANCHOR).not.toMatch(/[0-9a-f]{16}/u)
  })
})

describe("a stored offer with the same identity", () => {
  const stored = (status: Parameters<typeof storedOfferStands>[0]["status"]) => ({
    status,
    evidence_revision_key: "evidence-a",
    retired_evidence_key: null,
    candidate_hash: "candidate-a"
  })
  const changedPage = { evidenceKey: "evidence-b", candidateHash: "candidate-b" }

  it("keeps a No and an unanswered offer when a cited page changed", () => {
    expect(storedOfferStands(stored("rejected"), changedPage)).toBe(true)
    expect(storedOfferStands(stored("expired"), changedPage)).toBe(true)
    expect(storedOfferStands(stored("accepted"), changedPage)).toBe(true)
  })

  it("lets a retired offer and a reworded open offer through", () => {
    expect(storedOfferStands(stored("retired"), changedPage)).toBe(false)
    expect(
      storedOfferStands(stored("retired"), { evidenceKey: "evidence-a", candidateHash: "x" })
    ).toBe(true)
    expect(storedOfferStands(stored("offered"), changedPage)).toBe(false)
    expect(
      storedOfferStands(stored("offered"), {
        evidenceKey: "evidence-b",
        candidateHash: "candidate-a"
      })
    ).toBe(true)
  })
})

// One owner of "the owner said no": the offer's own status. The table that held a second copy
// was dropped by migration 0159; no code may read or write it again.
it("leaves no reader or writer of the dropped rejections table", () => {
  const SRC = join(import.meta.dirname, "..", "src")
  const offenders = readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.startsWith(join("persistence", "migrations")))
    .filter((name) => readFileSync(join(SRC, name), "utf8").includes("task_inference_rejections"))
  expect(offenders).toEqual([])
})
