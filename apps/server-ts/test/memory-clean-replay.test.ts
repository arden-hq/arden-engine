import { join } from "node:path"
import { machineTimeZone } from "@arden-hq/std/time"
import { ManagedFileRepository, managedFileRepositoryNodeLayer } from "@arden-hq/revisions/effect"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"

import { makeDailySummaryRunner } from "../src/automations/handlers/daily-summary.js"
import { wikiMaintenanceHandler } from "../src/automations/handlers/wiki-maintenance.js"
import { SYSTEM_AUTOMATION_SPECS } from "../src/automations/system.js"
import { corePageBudget } from "../src/memory/core-memory.js"
import type { HandlerItem } from "../src/persistence/automations/handler-item.js"
import { AutomationCatalog } from "../src/persistence/automations/catalog.js"
import type { AutomationJobLease } from "../src/persistence/automations/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { TranscriptQueries } from "../src/persistence/transcript/queries.js"
import { overPageLimit } from "../src/wiki/commit.js"
import { makeWikiListingMethods } from "../src/wiki/listing.js"
import { parseWikiPage } from "../src/wiki/page.js"
import { locateReplayCopy, runOnReplayCopy } from "./fixtures/replay-copy.js"

// The "Memory stays clean" changes on the real history, with no model. Opening the copy migrates
// it, so the chat summary repair runs on it. Only counts leave this file.

const located = locateReplayCopy()

it("replays the commit-point limit, the timer, Daily's days and chat summaries on the copy", async (context) => {
  if (located.kind === "absent") return context.skip(located.reason)
  const copy = located.copy

  const history = await Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* ManagedFileRepository
      const commits = yield* repository.history({ limit: null })
      const refused = new Map<string, number>()
      let limitedWrites = 0
      for (const commit of commits)
        for (const change of commit.changes) {
          const after = change.after
          if (after === null || after.state !== "active") continue
          if (corePageBudget({ path: after.path, pageId: after.resourceId }) === undefined) continue
          limitedWrites += 1
          const text = new TextDecoder().decode(yield* repository.readVersion(after))
          const page = yield* parseWikiPage(text).pipe(Effect.option)
          if (Option.isNone(page)) continue
          const over = overPageLimit({
            path: after.path,
            pageId: after.resourceId,
            body: page.value.body
          })
          if (over === undefined) continue
          const key = `${after.path} ${commit.origin.split(/[@.~]/u)[0] ?? ""}`
          refused.set(key, (refused.get(key) ?? 0) + 1)
        }
      return { commits: commits.length, limitedWrites, refused: Object.fromEntries(refused) }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        managedFileRepositoryNodeLayer({
          workingRoot: join(copy.wiki, "pages"),
          historyRoot: join(copy.wiki, ".wiki-history")
        })
      )
    )
  )

  const database = await runOnReplayCopy(
    copy,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const catalog = yield* AutomationCatalog
      const [ahead] = yield* sql<{ readonly summaries: number; readonly ahead: number }>`
        SELECT COUNT(*) AS summaries,
          COALESCE(SUM(through_sequence > COALESCE((SELECT MAX(seq) FROM session_messages AS m
            WHERE m.session_id = c.session_id), -1)), 0) AS ahead
        FROM chat_summaries AS c`
      yield* catalog.seedSystemAutomations(SYSTEM_AUTOMATION_SPECS)
      const [maintenance] = yield* sql<{
        readonly triggers: string
        readonly next_run_at: string | null
      }>`SELECT triggers, next_run_at FROM scheduled_tasks
        WHERE task_id = ${wikiMaintenanceHandler.spec.automationId}`
      return {
        summaries: ahead,
        maintenance: {
          types: (
            JSON.parse(maintenance?.triggers ?? "[]") as ReadonlyArray<{ readonly type: string }>
          ).map((trigger) => trigger.type),
          nextRunAt: maintenance?.next_run_at ?? null
        }
      }
    })
  )

  // Daily from 9 September on the copy, as if the position had been set then: which days
  // would run the model, with no model. The update itself starts the position two days back.
  const timezone = machineTimeZone()
  const daily = await Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* ManagedFileRepository
      const listing = makeWikiListingMethods(repository)
      return yield* Effect.promise(() =>
        runOnReplayCopy(
          copy,
          Effect.gen(function* () {
            let settled = "2026-09-09"
            const days: Array<{ readonly date: string; readonly excerpts: number }> = []
            let items = 0
            const runner = makeDailySummaryRunner({
              wiki: {
                snapshot: listing.snapshot,
                pageTimes: listing.pageTimes,
                createDirectory: () => Effect.die(new Error("The copy has a daily folder"))
              },
              sessions: yield* SessionStore,
              transcripts: yield* TranscriptQueries,
              position: {
                current: () => Effect.succeed({ settledDay: settled, tries: 0 }),
                tried: () => Effect.void,
                advance: ({ to }) =>
                  Effect.sync(() => {
                    settled = to
                  })
              },
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
                if (data.kind === "daily")
                  days.push({
                    date: data.date,
                    excerpts: data.markdown.split("\n\narden:").length - 1
                  })
                return Effect.succeed({
                  item: { ...item, runId: "run-1" },
                  state: "done" as const,
                  detail: null,
                  result: "Replayed with no model."
                })
              },
              timezone
            })
            const leasedAt = Date.parse("2026-11-13T12:00:00.000Z")
            yield* runner({
              id: "replay",
              token: "replay",
              attempt: 1,
              leasedAt,
              expiresAt: leasedAt + 30_000,
              payload: {
                automationId: "builtin-daily-summary",
                sessionId: "replay",
                name: "Daily summary",
                prompt: "Replay.",
                handler: "daily_summary"
              }
            } as unknown as AutomationJobLease)
            return { settled, days }
          })
        )
      )
    }).pipe(
      Effect.scoped,
      Effect.provide(
        managedFileRepositoryNodeLayer({
          workingRoot: join(copy.wiki, "pages"),
          historyRoot: join(copy.wiki, ".wiki-history")
        })
      )
    )
  )

  process.stdout.write(
    `Replay: ${history.commits} commits, ${history.limitedWrites} writes to a limited page, ` +
      `refused at the commit now: ${JSON.stringify(history.refused)}. ` +
      `Chat summaries ${database.summaries?.summaries}, ahead of their chat after the update ` +
      `${database.summaries?.ahead}. Maintenance after reseed: triggers ${database.maintenance.types.join(",")}, ` +
      `next timer run ${database.maintenance.nextRunAt}. Daily from 9 September: settled through ` +
      `${daily.settled}, model runs for ${daily.days.length} days: ` +
      `${daily.days.map((day) => `${day.date}:${day.excerpts}`).join(" ")}\n`
  )
  expect(database.summaries?.ahead).toBe(0)
  expect(database.maintenance).toEqual({ types: ["event"], nextRunAt: null })
  expect(daily.settled).toBe("2026-11-12")
}, 1_800_000)
