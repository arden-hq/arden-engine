import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { describe, expect, it } from "vitest"
import { automationRunEndedEvent } from "../src/automations/producers/automation-run.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import {
  causedChainDepth,
  chainMayWake,
  wakeChainDepth
} from "../src/persistence/automations/chain-depth.js"
import type { AutomationTriggerEvent } from "../src/persistence/automations/model.js"
import { AutomationTriggers } from "../src/persistence/automations/triggers.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const AT = "2026-10-12T09:00:00.000Z"

const wokenBy = (event: AutomationTriggerEvent) =>
  ({
    source: "event",
    queued_at: AT,
    event_type: event.eventType,
    event_key: event.eventKey,
    produced_by: event.producedBy,
    ...(event.chainDepth === 0 ? {} : { chain_depth: event.chainDepth }),
    context: event.context
  }) as const

const taskChangeBy = (automationId: string, producerWakeDepth: number): AutomationTriggerEvent => ({
  eventType: "task.changed",
  eventKey: "1",
  producedBy: automationId,
  chainDepth: causedChainDepth(automationId, producerWakeDepth),
  context: { task: { change: "updated", item_id: "task_1" } }
})

describe("chain depth", () => {
  it("an event the user or a source caused starts at depth 0 and may wake", () => {
    expect(causedChainDepth(null, 0)).toBe(0)
    expect(chainMayWake(0)).toBe(true)
  })

  it("A's run may wake B once", () => {
    const fromA = taskChangeBy("a", wakeChainDepth(undefined))
    expect(fromA.chainDepth).toBe(1)
    expect(chainMayWake(fromA.chainDepth)).toBe(true)
  })

  it("B's run, woken by A's event, cannot wake A back", () => {
    const fromB = taskChangeBy("b", wakeChainDepth(wokenBy(taskChangeBy("a", 0))))
    expect(fromB.chainDepth).toBe(2)
    expect(chainMayWake(fromB.chainDepth)).toBe(false)
  })

  it("the deepest cause of a batch sets the run's depth", () => {
    expect(
      wakeChainDepth({
        source: "coalesced",
        queued_at: AT,
        causes: [{ source: "manual", queued_at: AT }, wokenBy(taskChangeBy("a", 0))]
      })
    ).toBe(1)
  })

  it("a run-ended event follows the same rule", () => {
    const ended = (woken: ReturnType<typeof wokenBy> | undefined) =>
      automationRunEndedEvent({
        attemptId: 1,
        automationId: "a",
        automationRef: "a~1",
        name: "A",
        purpose: "user_automation",
        outcome: "finished",
        text: "",
        chat: undefined,
        wokenBy: woken
      })
    const first = ended(undefined)
    expect(first?.chainDepth).toBe(1)
    if (first === undefined) throw new Error("expected an event")
    expect(ended(wokenBy(first))?.chainDepth).toBe(2)
  })
})

describe("dispatch", () => {
  const taskEvent = (producedBy: string | null, chainDepth: number, key: string) => ({
    eventType: "task.changed" as const,
    eventKey: key,
    producedBy,
    chainDepth,
    context: { task: { change: "changed" } }
  })

  it("wakes the others once, never the producer, and nobody past one step", async () => {
    const outcome = await withTempDatabase(
      Effect.gen(function* () {
        const catalog = yield* AutomationCatalog
        const triggers = yield* AutomationTriggers
        const sql = yield* SqlClient.SqlClient
        const ids: Record<string, string> = {}
        for (const [index, name] of ["a", "b"].entries()) {
          const created = yield* catalog.create(
            {
              name,
              prompt: "React to a Task change",
              history: "fresh",
              triggers: [{ type: "event", event_type: "task.changed" }],
              idempotency_key: `6a3d1f0e-9b7c-4d2a-8e5f-1c2b3a4d5e6${index}`,
              idempotency_scope: "global"
            },
            "owner"
          )
          ids[name] = created.task_id
        }
        const woken = (event: ReturnType<typeof taskEvent>) =>
          Effect.gen(function* () {
            yield* sql`DELETE FROM automation_event_queue`
            yield* sql`DELETE FROM automation_event_dedupe`
            yield* triggers.dispatchEvent(event)
            const rows = yield* sql<{ readonly task_id: string }>`
              SELECT task_id FROM automation_event_queue`
            return ["a", "b"].filter((name) => rows.some((row) => row.task_id === ids[name]))
          })
        return {
          user: yield* woken(taskEvent(null, 0, "1")),
          aToB: yield* woken(taskEvent(ids["a"] ?? "", 1, "2")),
          bBack: yield* woken(taskEvent(ids["b"] ?? "", 2, "3"))
        }
      })
    )
    expect(outcome).toEqual({ user: ["a", "b"], aToB: ["b"], bBack: [] })
  })
})
