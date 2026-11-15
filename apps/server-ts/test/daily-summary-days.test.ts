import { Effect } from "effect"
import { expect, it } from "vitest"

import {
  dailyStartPosition,
  makeDailySummaryRunner
} from "../src/automations/handlers/daily-summary.js"
import type { HandlerItem } from "../src/persistence/automations/handler-item.js"
import type { AutomationJobLease } from "../src/persistence/automations/store.js"
import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { DailySummaryPosition } from "../src/persistence/daily-summary/store.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { TranscriptQueries } from "../src/persistence/transcript/queries.js"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import type { PageRecord } from "../src/wiki/snapshot.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// Daily Summary takes its day from a saved position: each ended day after it gets its own run,
// with that day's evidence only. Real chat stores; the wiki and the model run are fakes.

const NOW = Date.parse("2026-11-13T10:00:00.000Z")

const turn = Effect.fn("turn")(function* (sessionId: string, id: string, at: string) {
  const chat = yield* ChatWriteStore
  const started = yield* chat.start({
    sessionId,
    clientId: id,
    requestHash: id,
    assistantMessageId: `${id}-answer`,
    message: { message_id: id, client_id: id, role: "user", content: id, created_at: at }
  })
  if (started._tag !== "Started") throw new Error(`Turn ${id} did not start: ${started._tag}`)
  yield* chat.finish({
    runId: started.runId,
    messages: [
      ...started.activeMessages,
      { message_id: `${id}-answer`, role: "assistant", content: `Noted ${id}`, created_at: at }
    ]
  })
})

const job = {
  id: "job-1",
  token: "token-1",
  attempt: 1,
  leasedAt: NOW,
  expiresAt: NOW + 30_000,
  payload: {
    automationId: "builtin-daily-summary",
    sessionId: "daily-session",
    name: "Daily summary",
    prompt: "Write the day.",
    handler: "daily_summary"
  }
} as unknown as AutomationJobLease

const contract: PageRecord = {
  resource: {
    resourceId: "daily",
    path: "daily/README.md",
    blobId: "0".repeat(64),
    state: "active",
    versionId: "0".repeat(64)
  },
  page: Effect.runSync(
    parseWikiPage(
      formatWikiPage({
        pageId: "daily",
        title: "Daily",
        aliases: [],
        lifecycle: "active",
        redirectTo: null,
        metadata: { producer_automation_id: "builtin-daily-summary" },
        body: "Contract."
      }),
      "daily"
    )
  )
}

const dailyRunner = Effect.fn("dailyRunner")(function* () {
  const ran: Array<{
    readonly date: string
    readonly messages: ReadonlyArray<string>
    readonly markdown: string
  }> = []
  let items = 0
  const runner = makeDailySummaryRunner({
    wiki: {
      snapshot: () => Effect.succeed({ head: "head", pages: [contract] }),
      pageTimes: () => Effect.succeed(new Map()),
      createDirectory: () => Effect.die(new Error("the contract exists"))
    },
    sessions: yield* SessionStore,
    transcripts: yield* TranscriptQueries,
    position: yield* DailySummaryPosition,
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
        Effect.succeed({ ...item, phase: "settled", runId: "run-1", failure: null })
    },
    runItem: (_job, item) => {
      const data = item.input.data
      if (data.kind === "daily")
        ran.push({
          date: data.date,
          messages: [
            ...new Set(
              [...data.markdown.matchAll(/\(message ([a-z0-9-]+)\)/gu)].map(
                (match) => match[1] ?? ""
              )
            )
          ],
          markdown: data.markdown
        })
      return Effect.succeed({
        item: { ...item, runId: "run-1" },
        state: "done" as const,
        detail: null,
        result: "Written."
      })
    },
    timezone: "UTC"
  })
  return { ran, runner }
})

it("fills each ended day after the saved one, each from its own day's messages", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const position = yield* DailySummaryPosition
      const chat = (yield* sessions.create({})).sessionId
      yield* turn(chat, "tenth", "2026-11-10T09:00:00.000Z")
      yield* turn(chat, "eleventh", "2026-11-11T09:00:00.000Z")
      yield* turn(chat, "twelfth-a", "2026-11-12T08:00:00.000Z")
      yield* turn(chat, "twelfth-b", "2026-11-12T23:59:00.000Z")
      yield* turn(chat, "today", "2026-11-13T09:00:00.000Z")
      // The computer was off: nothing settled after the 8th, and the 9th had no messages.
      yield* position.initialize("2026-11-08")
      const { ran, runner } = yield* dailyRunner()
      const first = yield* runner(job)
      const settled = yield* position.settled()
      const again = yield* runner(job)
      return {
        ran: ran.map(({ date, messages }) => ({ date, messages })),
        first: first.status,
        settled,
        again: again.outcome
      }
    })
  )
  expect(outcome).toEqual({
    ran: [
      { date: "2026-11-10", messages: ["tenth", "tenth-answer"] },
      { date: "2026-11-11", messages: ["eleventh", "eleventh-answer"] },
      {
        date: "2026-11-12",
        messages: ["twelfth-a", "twelfth-a-answer", "twelfth-b", "twelfth-b-answer"]
      }
    ],
    first: "ended",
    settled: "2026-11-12",
    again: "no_input"
  })
})

it("starts the position the day before the last ended day, so an update runs no old days", () => {
  expect(dailyStartPosition(NOW, "UTC")).toBe("2026-11-11")
  expect(dailyStartPosition(Date.parse("2026-11-13T23:30:00.000Z"), "Asia/Tokyo")).toBe(
    "2026-11-12"
  )
})

it("says in the page input how much of a busy day the limit left out", async () => {
  const markdown = await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const chat = (yield* sessions.create({})).sessionId
      for (let index = 0; index < 20; index += 1)
        yield* turn(
          chat,
          `busy-${index}`,
          `2026-11-12T${String(index).padStart(2, "0")}:00:00.000Z`
        )
      yield* (yield* DailySummaryPosition).initialize("2026-11-11")
      const { ran, runner } = yield* dailyRunner()
      yield* runner(job)
      return ran.map((day) => day.markdown)
    })
  )
  expect(markdown).toHaveLength(1)
  expect(markdown[0]).toContain(
    "Coverage: every owner chat's messages from this day (40) and every report last changed on this day (0)."
  )
  expect(markdown[0]).toContain(
    "Left out by that limit: 10 messages and 0 reports; 0 excerpts shortened."
  )
})
