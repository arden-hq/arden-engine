import { expect, it } from "vitest"
import {
  spaceReviewAdmission,
  type ReviewChange,
  type ReviewHold
} from "../src/automations/space-review-admission.js"
import type { SpaceReviewReads } from "../src/persistence/automations/space-review.js"

const EXPECTED: Record<ReviewChange, Record<ReviewHold, boolean>> = {
  chat_turn: { nothing: true, unfinished_tasks: true, open_offers: true },
  mail: { nothing: true, unfinished_tasks: true, open_offers: true },
  space_settings: { nothing: true, unfinished_tasks: true, open_offers: true },
  memory_page: { nothing: false, unfinished_tasks: false, open_offers: false },
  task: { nothing: false, unfinished_tasks: true, open_offers: true }
}

const semantic = (status: string, retryAt: string | null, instructions: string) =>
  JSON.stringify({
    space: JSON.stringify({ name: "S", instructions, inference_policy: {}, page_id: "p" }),
    settled: "settled-1",
    tasks: [JSON.stringify({ item_id: "work:1", status, next_attempt_at: retryAt })],
    sources: []
  })

const cell = (change: ReviewChange, hold: ReviewHold) => {
  const status = hold === "unfinished_tasks" ? "open" : "done"
  const reads = {
    space: { name: "S", instructions: "Keep." },
    openTasks: [],
    proposals: hold === "open_offers" ? ["An offer"] : [],
    memory: { base: "r1", head: "r2" },
    pages:
      change === "memory_page"
        ? [{ pageId: "p", path: "n.md", version: "v2", basis: "owned" }]
        : [],
    chats:
      change === "chat_turn" ? [{ sessionId: "s", sessionRef: "c", runId: "r", turnId: "t" }] : [],
    removed: [],
    items:
      change === "mail" ? [{ itemId: "i", source: "g", sender: "S", title: "T", isNew: true }] : []
  } as unknown as SpaceReviewReads
  const current = semantic(
    status,
    change === "task" ? "2026-11-02" : null,
    change === "space_settings" ? "New." : "Keep."
  )
  return spaceReviewAdmission(
    { semantic: current, reads },
    { semantic: semantic(status, null, "Keep.") },
    false
  )
}

it("each kind of change starts a Space review or not, whatever the Space holds", () => {
  for (const change of Object.keys(EXPECTED) as Array<ReviewChange>)
    for (const hold of Object.keys(EXPECTED[change]) as Array<ReviewHold>) {
      const verdict = cell(change, hold)
      const label = `${change}/${hold}`
      expect([...verdict.changes], label).toEqual([change])
      expect([...verdict.holds], label).toEqual([hold])
      expect(verdict.admission, label).toBe(
        EXPECTED[change][hold] ? "changed" : "nothing_to_act_on"
      )
    }
})
