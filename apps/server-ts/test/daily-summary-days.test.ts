import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"

import {
  dailyStartPosition,
  makeDailySummaryRunner
} from "../src/automations/handlers/daily-summary.js"
import type { HandlerItem } from "../src/persistence/automations/handler-item.js"
import type { AutomationJobLease } from "../src/persistence/automations/store.js"
import { resumeAutomation } from "../src/persistence/sqlite/automation-resume.js"
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

const page = (path: string, producer: string, body: string): PageRecord => ({
  resource: { ...contract.resource, resourceId: path, path },
  page: Effect.runSync(
    parseWikiPage(
      formatWikiPage({
        pageId: path,
        title: path,
        aliases: [],
        lifecycle: "active",
        redirectTo: null,
        metadata: { producer_automation_id: producer },
        body
      }),
      path
    )
  )
})

const dailyRunner = Effect.fn("dailyRunner")(function* (
  options: {
    readonly pages?: ReadonlyArray<PageRecord>
    readonly updatedAt?: ReadonlyMap<string, string>
    readonly fails?: (date: string) => boolean
  } = {}
) {
  const ran: Array<{
    readonly date: string
    readonly messages: ReadonlyArray<string>
    readonly markdown: string
  }> = []
  let items = 0
  const runner = makeDailySummaryRunner({
    wiki: {
      snapshot: () => Effect.succeed({ head: "head", pages: [contract, ...(options.pages ?? [])] }),
      pageTimes: () =>
        Effect.succeed(
          new Map(
            [...(options.updatedAt ?? [])].map(([pageId, updatedAt]) => [
              pageId,
              { createdAt: updatedAt, updatedAt }
            ])
          )
        ),
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
      const failed = data.kind === "daily" && options.fails?.(data.date) === true
      return Effect.succeed({
        item: { ...item, runId: "run-1" },
        state: failed ? ("failed" as const) : ("done" as const),
        detail: failed ? "The provider failed 3 times" : null,
        result: failed ? null : "Written."
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
      yield* position.current("2026-11-08")
      const { ran, runner } = yield* dailyRunner()
      const first = yield* runner(job)
      const settled = (yield* position.current("2026-11-01")).settledDay
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
      yield* (yield* DailySummaryPosition).current("2026-11-11")
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

it("keeps the stored position across restarts, and moves it only from where it is", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const position = yield* DailySummaryPosition
      const first = yield* position.current("2026-11-08")
      yield* position.advance({ from: "2026-11-08", to: "2026-11-09" })
      const restarted = yield* position.current("2026-11-11")
      const stale = yield* position
        .advance({ from: "2026-11-05", to: "2026-11-12" })
        .pipe(Effect.flip, Effect.map((error) => error.reason))
      return { first: first.settledDay, restarted: restarted.settledDay, stale }
    })
  )
  expect(outcome).toEqual({ first: "2026-11-08", restarted: "2026-11-09", stale: "conflict" })
})

it("settles a day whose page is already there without a run", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const chat = (yield* sessions.create({})).sessionId
      yield* turn(chat, "twelfth", "2026-11-12T09:00:00.000Z")
      const position = yield* DailySummaryPosition
      yield* position.current("2026-11-11")
      const { ran, runner } = yield* dailyRunner({
        pages: [page("daily/2026-11-12.md", "builtin-daily-summary", "Written before a crash.")]
      })
      yield* runner(job)
      return { ran: ran.length, settled: (yield* position.current("2026-11-01")).settledDay }
    })
  )
  expect(outcome).toEqual({ ran: 0, settled: "2026-11-12" })
})

it("reads archived chats, past the first page of chats and of messages", async () => {
  const messages = await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const archived = (yield* sessions.create({})).sessionId
      yield* turn(archived, "archived", "2026-11-12T01:00:00.000Z")
      yield* sessions.archive(archived)
      const long = (yield* sessions.create({})).sessionId
      for (let index = 0; index < 126; index += 1)
        yield* turn(long, `long-${index}`, `2026-11-12T02:${String(index % 60).padStart(2, "0")}:00.000Z`)
      for (let index = 0; index < 100; index += 1)
        yield* turn(
          (yield* sessions.create({})).sessionId,
          `chat-${index}`,
          `2026-11-12T12:${String(index % 60).padStart(2, "0")}:00.000Z`
        )
      yield* (yield* DailySummaryPosition).current("2026-11-11")
      const { ran, runner } = yield* dailyRunner()
      yield* runner(job)
      return ran.map((day) => day.markdown)
    })
  )
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain("every owner chat's messages from this day (454)")
}, 60_000)

it("reads the reports last changed on each day, and only those", async () => {
  const markdown = await withTempDatabase(
    Effect.gen(function* () {
      yield* (yield* DailySummaryPosition).current("2026-11-10")
      const { ran, runner } = yield* dailyRunner({
        pages: [
          page("reports/eleventh.md", "user-automation", "Eleventh report."),
          page("reports/twelfth.md", "user-automation", "Twelfth report.")
        ],
        updatedAt: new Map([
          ["reports/eleventh.md", "2026-11-11T10:00:00.000Z"],
          ["reports/twelfth.md", "2026-11-12T10:00:00.000Z"]
        ])
      })
      yield* runner(job)
      return ran.map((day) => ({
        date: day.date,
        reports: [...day.markdown.matchAll(/^arden:memory\/(\S+)$/gmu)].map((match) => match[1])
      }))
    })
  )
  expect(markdown).toEqual([
    { date: "2026-11-11", reports: ["reports/eleventh.md"] },
    { date: "2026-11-12", reports: ["reports/twelfth.md"] }
  ])
})

it("settles a day unwritten once its run has failed in two jobs, and says so", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const chat = (yield* sessions.create({})).sessionId
      yield* turn(chat, "eleventh", "2026-11-11T09:00:00.000Z")
      yield* turn(chat, "twelfth", "2026-11-12T09:00:00.000Z")
      const position = yield* DailySummaryPosition
      yield* position.current("2026-11-10")
      const { ran, runner } = yield* dailyRunner({ fails: (date) => date === "2026-11-11" })
      const jobs = [yield* runner(job), yield* runner(job), yield* runner(job)]
      return {
        ran: ran.map((day) => day.date),
        outcome: jobs.map((result) => result.outcome),
        note: jobs[2]?.result,
        settled: (yield* position.current("2026-11-01")).settledDay
      }
    })
  )
  expect(outcome).toEqual({
    ran: ["2026-11-11", "2026-11-11", "2026-11-12"],
    outcome: ["failed", "failed", "finished"],
    note: expect.stringContaining("daily/2026-11-11.md was not written: its run did not finish in 2 jobs"),
    settled: "2026-11-12"
  })
})

it("starts again from its resume after the owner pauses it, owing no paused days", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const position = yield* DailySummaryPosition
      yield* position.current("2026-11-01")
      yield* resumeAutomation({ sql, automationId: "user-automation", nextRunAt: null })
      const other = (yield* position.current("2026-11-11")).settledDay
      yield* resumeAutomation({ sql, automationId: "builtin-daily-summary", nextRunAt: null })
      return { other, resumed: (yield* position.current("2026-11-11")).settledDay }
    })
  )
  expect(outcome).toEqual({ other: "2026-11-01", resumed: "2026-11-11" })
})
