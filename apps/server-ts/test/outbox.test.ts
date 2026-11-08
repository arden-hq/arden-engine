import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"

import { drainOutbox, nextOutboxAttemptAt, type Outbox } from "../src/runtime/outbox.js"

const outbox = (
  rows: ReadonlyArray<string>,
  delivered: string[],
  deferred: string[]
): Outbox<string, never, never> => ({
  name: "test",
  pending: Effect.succeed(rows),
  deliver: (row) => {
    if (row === "fails") return Effect.fail(new Error("busy"))
    if (row === "dies") return Effect.die(new Error("defect"))
    delivered.push(row)
    return Effect.succeed(row !== "settled")
  },
  defer: (row, cause) =>
    Effect.sync(() => {
      deferred.push(`${row}:${Cause.hasDies(cause) ? "defect" : "failure"}`)
    })
})

describe("outbox drainer", () => {
  it("delivers oldest first, defers failures and defects, and counts only deliveries", async () => {
    const delivered: string[] = []
    const deferred: string[] = []
    const count = await Effect.runPromise(
      drainOutbox(outbox(["first", "fails", "settled", "dies", "last"], delivered, deferred))
    )
    expect(delivered).toEqual(["first", "settled", "last"])
    expect(deferred).toEqual(["fails:failure", "dies:defect"])
    expect(count).toBe(2)
  })

  it("fails the batch when the due rows cannot be read", async () => {
    const failing: Outbox<string, string, never> = {
      name: "test",
      pending: Effect.fail("unreadable"),
      deliver: () => Effect.succeed(true),
      defer: () => Effect.void
    }
    const exit = await Effect.runPromiseExit(drainOutbox(failing))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("backs off per failed attempt, capped at 30 seconds", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z")
    expect(
      [1, 2, 3, 4, 5, 6, 9].map(
        (attempt) => (Date.parse(nextOutboxAttemptAt(now, attempt)) - now) / 1_000
      )
    ).toEqual([1, 2, 4, 8, 16, 30, 30])
  })
})
