import { Effect } from "effect"
import { expect, it } from "vitest"

import { makeWikiMaintenanceRunner } from "../src/automations/handlers/wiki-maintenance.js"
import type { HandlerItem } from "../src/persistence/automations/handler-item.js"
import type { AutomationJobLease } from "../src/persistence/automations/store.js"
import { WikiMaintenanceStore } from "../src/persistence/wiki-maintenance/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const revision = (n: number) => String(n).repeat(64).slice(0, 64)
const name = (head: string | null) => (head === null ? "none" : `r${head[0]}`)

const job = {
  id: "job-1",
  token: "token-1",
  attempt: 1,
  leasedAt: 0,
  expiresAt: 30_000,
  payload: {
    automationId: "builtin-wiki-maintenance",
    sessionId: "tidy-session",
    name: "Tidy",
    prompt: "Tidy Memory.",
    handler: "wiki_maintenance"
  }
} as unknown as AutomationJobLease

/**
 * Tidy over a made-up Memory history whose head moves one commit before each job. Each review ends
 * as `reports` says for that review, by default blocked, as a run refused an edit to a record
 * would. Returns, per job, the ranges Tidy reviewed, where its place stood after, what the job told
 * the owner, and whether a refused range is still marked.
 */
const tidy = (jobs: number, reports: (review: number) => "blocked" | "done" = () => "blocked") =>
  Effect.gen(function* () {
    const maintenance = yield* WikiMaintenanceStore
    yield* maintenance.initialize(revision(1))
    let head = revision(1)
    let items = 0
    let reviews = 0
    const reviewed: Array<string> = []
    const runner = makeWikiMaintenanceRunner({
      wiki: {
        prepareMaintenance: ({ processedHead }) =>
          Effect.succeed(
            processedHead === head
              ? ({ kind: "idle", head } as const)
              : ({ kind: "review", sourceHead: head, markdown: "Made-up range." } as const)
          )
      },
      maintenance,
      handlerItems: {
        prepareHandlerItem: (_job, input) =>
          Effect.succeed({
            id: `item-${(items += 1)}`,
            attempt: 1,
            previousRunId: null,
            reviewed: 0,
            skipped: 0,
            input,
            phase: "pending",
            runId: null
          } satisfies HandlerItem),
        settleHandlerItem: (_job, item) =>
          Effect.succeed<HandlerItem>({
            ...(item as HandlerItem),
            phase: "settled",
            runId: "run-1",
            failure: null
          })
      },
      runItem: (_job, item) => {
        const data = item.input.data
        if (data.kind === "wiki")
          reviewed.push(`${name(data.processedHead)}..${name(data.sourceHead)}`)
        const state = reports((reviews += 1))
        return Effect.succeed({
          item: { ...item, runId: "run-1" },
          state,
          detail: state === "blocked" ? "Made-up refusal" : null,
          result: null
        })
      }
    })
    const outcome: Array<{
      readonly reviewed: ReadonlyArray<string>
      readonly place: string
      readonly told: string | null
      readonly marked: boolean
    }> = []
    for (let n = 2; n < 2 + jobs; n += 1) {
      head = revision(n)
      reviewed.length = 0
      const result = yield* runner(job)
      outcome.push({
        reviewed: [...reviewed],
        place: name(yield* maintenance.processedHead()),
        told: result.result,
        marked: (yield* maintenance.refusal()) !== undefined
      })
    }
    return outcome
  })

it("Tidy retries a range it was blocked on once, then moves past it and says so", async () => {
  const outcome = await withTempDatabase(tidy(3))
  expect(outcome.map(({ reviewed, place, marked }) => ({ reviewed, place, marked }))).toEqual([
    { reviewed: ["r1..r2"], place: "r1", marked: true },
    { reviewed: ["r1..r3", "r2..r3"], place: "r2", marked: true },
    { reviewed: ["r2..r4", "r3..r4"], place: "r3", marked: true }
  ])
  expect(outcome[0]?.told).not.toMatch(/moved past/u)
  expect(outcome[1]?.told).toMatch(
    new RegExp(`moved past the changes up to ${revision(2).slice(0, 12)}`, "u")
  )
  expect(outcome[1]?.told).toMatch(/Made-up refusal/u)
})

it("a range Tidy finishes on its retry moves its place as usual and leaves no mark", async () => {
  const outcome = await withTempDatabase(tidy(2, (review) => (review === 1 ? "blocked" : "done")))
  expect(outcome.map(({ reviewed, place, marked }) => ({ reviewed, place, marked }))).toEqual([
    { reviewed: ["r1..r2"], place: "r1", marked: true },
    { reviewed: ["r1..r3"], place: "r3", marked: false }
  ])
  expect(outcome[1]?.told).not.toMatch(/moved past/u)
})
