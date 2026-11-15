import { readdirSync, readFileSync } from "node:fs"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  spaceReviewAdmission,
  type ReviewChange,
  type ReviewHold
} from "../src/automations/space-review-admission.js"
import { DECISION_SITES } from "../src/models/decisions/sites.js"
import {
  askedByOwner,
  SpaceReviewInputSchema,
  type SpaceReviewReads
} from "../src/persistence/automations/space-review.js"

// The table as the spec states it, written out independently of the code's table.
const EXPECTED: Record<ReviewChange, Record<ReviewHold, boolean>> = {
  chat_turn: { nothing: true, unfinished_tasks: true, open_offers: true },
  mail: { nothing: true, unfinished_tasks: true, open_offers: true },
  space_settings: { nothing: true, unfinished_tasks: true, open_offers: true },
  memory_page: { nothing: false, unfinished_tasks: false, open_offers: false },
  task: { nothing: false, unfinished_tasks: true, open_offers: true }
}

interface MadeTask {
  readonly item_id: string
  readonly status: "open" | "deferred" | "done" | "cancelled"
  readonly next_attempt_at?: string
}

const task = (item_id: string, status: MadeTask["status"], next_attempt_at?: string): MadeTask => ({
  item_id,
  status,
  ...(next_attempt_at === undefined ? {} : { next_attempt_at })
})

const semantic = (
  tasks: ReadonlyArray<MadeTask>,
  instructions: string | null = "Keep it short."
): string =>
  JSON.stringify({
    space: JSON.stringify({
      name: "Space one",
      instructions,
      inference_policy: { enabled: true },
      policy_generation: 1,
      page_id: "page-1",
      page_path: "spaces/one.md"
    }),
    settled: "settled-1",
    tasks: tasks.map((entry) =>
      JSON.stringify({
        item_id: entry.item_id,
        text: `Task ${entry.item_id}`,
        body: null,
        status: entry.status,
        owner: "arden",
        blocked: 0,
        waiting_on: null,
        due_at: null,
        next_attempt_at: entry.next_attempt_at ?? null
      })
    ),
    sources: []
  })

const reads = (patch: Partial<SpaceReviewReads> = {}): SpaceReviewReads => ({
  space: { name: "Space one", instructions: "Keep it short." },
  openTasks: [],
  proposals: [],
  memory: { base: "rev-1", head: "rev-2" },
  pages: [],
  chats: [],
  removed: [],
  items: [],
  ...patch
})

const page = (basis: SpaceReviewReads["pages"][number]["basis"]) => ({
  pageId: `page-${basis}`,
  path: `notes/${basis}.md`,
  version: "v2",
  basis,
  previousVersion: "v1"
})

const item = (isNew: boolean) => ({
  itemId: "item-1",
  source: "gmail",
  sender: "Someone",
  title: "A made-up message",
  snippet: "Made-up text.",
  receivedAt: "2026-11-01T00:00:00Z",
  reason: "Made-up reason",
  isNew
})

const HELD_TASKS = [task("work:held", "open")]

/** A review state with exactly one change and one hold, against a checkpoint. */
const cell = (change: ReviewChange, hold: ReviewHold) => {
  const before = hold === "unfinished_tasks" ? HELD_TASKS : [task("work:gone", "done")]
  const after =
    change === "task"
      ? before.map((entry) => ({ ...entry, next_attempt_at: "2026-11-02" }))
      : before
  const current = {
    semantic: semantic(after, change === "space_settings" ? "New instructions." : "Keep it short."),
    reads: reads({
      ...(hold === "open_offers" ? { proposals: ["An offer"] } : {}),
      ...(change === "chat_turn"
        ? { chats: [{ sessionId: "s1", sessionRef: "chat-1", runId: "run-1", turnId: "t1" }] }
        : {}),
      ...(change === "mail" ? { items: [item(true)] } : {}),
      ...(change === "memory_page" ? { pages: [page("owned")] } : {})
    })
  }
  return spaceReviewAdmission(current, { semantic: semantic(before) }, false)
}

describe("Space review admission", () => {
  for (const change of Object.keys(EXPECTED) as Array<ReviewChange>)
    for (const hold of Object.keys(EXPECTED[change]) as Array<ReviewHold>)
      it(`${change} while the Space holds ${hold}: ${EXPECTED[change][hold] ? "starts" : "skips"}`, () => {
        const verdict = cell(change, hold)
        expect([...verdict.changes]).toEqual([change])
        expect([...verdict.holds]).toEqual([hold])
        expect(verdict.admission).toBe(EXPECTED[change][hold] ? "changed" : "nothing_to_act_on")
      })

  it("no change at all is unchanged, whatever the Space holds", () => {
    const verdict = spaceReviewAdmission(
      { semantic: semantic(HELD_TASKS), reads: reads({ proposals: ["An offer"] }) },
      { semantic: semantic(HELD_TASKS) },
      false
    )
    expect(verdict.changes.size).toBe(0)
    expect(verdict.admission).toBe("unchanged")
  })

  it("starts when the owner asked, even with nothing changed", () => {
    const verdict = spaceReviewAdmission(
      { semantic: semantic([]), reads: reads() },
      { semantic: semantic([]) },
      true
    )
    expect(verdict.admission).toBe("changed")
  })

  it("the owner asked when a manual run or a proposal recheck is among the run's causes", () => {
    const queued_at = "2026-01-01T00:00:00.000Z"
    const event = (event_type: string) =>
      ({
        source: "event",
        queued_at,
        event_type,
        event_key: "k-1",
        produced_by: null,
        context: {}
      }) as const
    const wake = { source: "wake", queued_at } as const
    const manual = { source: "manual", queued_at } as const
    expect(askedByOwner(manual)).toBe(true)
    expect(askedByOwner(event("space.proposal_review_requested"))).toBe(true)
    expect(askedByOwner(wake)).toBe(false)
    expect(askedByOwner(event("wiki.changed"))).toBe(false)
    expect(askedByOwner({ source: "coalesced", queued_at, causes: [wake, manual] })).toBe(true)
    expect(
      askedByOwner({ source: "coalesced", queued_at, causes: [wake, event("wiki.changed")] })
    ).toBe(false)
  })

  it("Memory page changes alone never start, whatever the Space holds", () => {
    const holding: Record<
      ReviewHold,
      { tasks: ReadonlyArray<MadeTask>; proposals: Array<string> }
    > = {
      nothing: { tasks: [], proposals: [] },
      unfinished_tasks: { tasks: HELD_TASKS, proposals: [] },
      open_offers: { tasks: [], proposals: ["An offer"] }
    }
    for (const [hold, held] of Object.entries(holding))
      for (const patch of [
        { pages: [page("owned")] },
        { pages: [page("source")] },
        { pages: [page("linked")] },
        { pages: [page("resident")] },
        { removed: ["notes/left.md"] },
        { pages: [page("owned"), page("source"), page("linked")], removed: ["notes/left.md"] }
      ]) {
        const verdict = spaceReviewAdmission(
          {
            semantic: semantic(held.tasks),
            reads: reads({ ...patch, proposals: held.proposals })
          },
          { semantic: semantic(held.tasks) },
          false
        )
        expect([...verdict.holds]).toEqual([hold])
        expect(verdict.admission).not.toBe("changed")
      }
  })

  it("a resident page is shared context and is no change to the Space", () => {
    const verdict = spaceReviewAdmission(
      { semantic: semantic(HELD_TASKS), reads: reads({ pages: [page("resident")] }) },
      { semantic: semantic(HELD_TASKS) },
      false
    )
    expect(verdict.admission).toBe("unchanged")
  })

  it("a source that left the review's pages is a Memory page change, which starts nothing", () => {
    const verdict = spaceReviewAdmission(
      { semantic: semantic(HELD_TASKS), reads: reads({ removed: ["notes/left.md"] }) },
      { semantic: semantic(HELD_TASKS) },
      false
    )
    expect([...verdict.changes]).toEqual(["memory_page"])
    expect(verdict.admission).toBe("nothing_to_act_on")
  })

  it("a deferred Task is held; a done or cancelled one is not", () => {
    const held = (status: MadeTask["status"]) =>
      spaceReviewAdmission(
        { semantic: semantic([task("work:1", status)]), reads: reads({ pages: [page("owned")] }) },
        { semantic: semantic([task("work:1", status)]) },
        false
      ).holds
    expect([...held("deferred")]).toEqual(["unfinished_tasks"])
    expect([...held("open")]).toEqual(["unfinished_tasks"])
    expect([...held("done")]).toEqual(["nothing"])
    expect([...held("cancelled")]).toEqual(["nothing"])
  })

  it("an old mail item is no change; a new one is", () => {
    const mail = (isNew: boolean) =>
      spaceReviewAdmission(
        { semantic: semantic([]), reads: reads({ items: [item(isNew)] }) },
        { semantic: semantic([]) },
        false
      ).admission
    expect(mail(false)).toBe("unchanged")
    expect(mail(true)).toBe("changed")
  })

  it("the first review of a Space starts: the review has never seen its settings", () => {
    const verdict = spaceReviewAdmission(
      { semantic: semantic([]), reads: reads() },
      undefined,
      false
    )
    expect([...verdict.changes]).toEqual(["space_settings"])
    expect(verdict.admission).toBe("changed")
  })

  it("reads a checkpoint written in the older semantic shape", () => {
    const older = JSON.stringify({
      space: JSON.stringify({
        name: "Space one",
        instructions: "Keep it short.",
        autonomy: "ask",
        inference_policy: { enabled: true },
        policy_generation: 1,
        page_id: "page-1",
        page_path: "spaces/one.md"
      }),
      tasks: [],
      sources: []
    })
    const verdict = spaceReviewAdmission(
      { semantic: semantic([]), reads: reads() },
      { semantic: older },
      false
    )
    expect(verdict.admission).toBe("unchanged")
  })

  it("still decodes a stored input written before the check, with its fingerprint", () => {
    const stored = {
      admission: "unchanged",
      spaceId: "space-1",
      fingerprint: "made-up",
      repositoryHead: null,
      pages: [],
      chats: [],
      semantic: semantic([]),
      unresolved: [],
      reads: reads(),
      prompt: "Made-up prompt"
    }
    expect(Schema.decodeUnknownSync(SpaceReviewInputSchema)(stored).admission).toBe("unchanged")
  })

  it("is the only place a review's admission is decided, and no model decides it", () => {
    const src = new URL("../src/", import.meta.url)
    const deciders = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .filter((file) =>
        /admission:\s*"(changed|unchanged|nothing_to_act_on)"|\.admission\s*=[^=]/.test(
          readFileSync(new URL(file, src), "utf8")
        )
      )
    expect(deciders).toEqual([])
    expect(Object.keys(DECISION_SITES).filter((site) => site.includes("review"))).toEqual([])
    const reviewFiles = readdirSync(new URL("automations/", src)).filter((file) =>
      file.startsWith("space-review")
    )
    for (const file of reviewFiles)
      expect(readFileSync(new URL(`automations/${file}`, src), "utf8")).not.toMatch(/\bdecide\(/)
  })
})
