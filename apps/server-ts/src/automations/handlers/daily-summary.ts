import { localDayOf, machineTimeZone } from "@arden-hq/std/time"
import { DateTime, Effect, Predicate } from "effect"
import type { SessionStore } from "../../persistence/sessions/store.js"
import type { TranscriptQueries } from "../../persistence/transcript/queries.js"
import { ownerText } from "../../persistence/transcript/owner-words.js"
import { DAILY_SUMMARY_AUTOMATION_ID } from "../../persistence/automations/model.js"
import type { AutomationHandlerItems } from "../../persistence/automations/handler-items.js"
import { PROMPT_TEXT } from "../../prompts/catalog.js"
import { markdownValue } from "../../prompts/format.js"
import type { Wiki } from "../../wiki/service.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../../wiki/authority.js"
import { automationOrigin } from "../../wiki/commit.js"
import { pageKind, producingAutomation, recordFolders } from "../../wiki/collections.js"
import type { HandlerItemRunner } from "../handler-item-run.js"
import { runItemLoop } from "../item-loop.js"
import type { AutomationRunner } from "../runner.js"
import type { DailySummaryPosition } from "../../persistence/daily-summary/store.js"
import { handlerItemText, type SystemAutomationHandler } from "../system-handler.js"
import { chatHref } from "../../sessions/chat-href.js"

const DAILY_CONTRACT = `## Purpose
Dated personal chronology and reflection, including summaries of recorded Arden activity.
## Producers
Daily summary Automation publishes YYYY-MM-DD.md; the user may keep separately named journal pages.
## Consumers
Questions about what happened on a date; follow evidence links for details.
## Boundaries
Recorded activity only, not comprehensive life tracking or a second current backlog. Preserve user-authored pages.
## Retention
Keep dated notes until the user requests removal; revision history preserves edits.
## Records
YYYY-MM-DD.md uses the machine's local calendar date. Read its observation period, source references, and coverage gaps.
`

const EVIDENCE_EXCERPTS = 30
const EVIDENCE_CHARS = 16_000
const EXCERPT_CHARS = 2_000
const SESSION_PAGE = 100
const MESSAGE_PAGE = 250
const TRIES_BEFORE_DAY_SKIPPED = 2

const nextDay = (day: string, days = 1): string =>
  DateTime.formatIsoDate(DateTime.add(DateTime.makeUnsafe(`${day}T00:00:00Z`), { days }))

const dayStart = (day: string, timezone: string): DateTime.Zoned =>
  DateTime.makeZonedUnsafe(`${day}T00:00:00`, { timeZone: timezone, adjustForTimeZone: true })

/** The day before the last ended day: where the position starts, so the first job after an
 * update, or after the owner resumes Daily Summary, writes only the last ended day's page. */
const dailyStartPosition = (nowMs: number, timezone: string): string =>
  nextDay(localDayOf(nowMs, timezone), -2)

type DayPreparation =
  | { readonly kind: "settled"; readonly note?: string }
  | { readonly kind: "write"; readonly markdown: string }

export const makeDailySummaryRunner = (services: {
  readonly wiki: Pick<Wiki["Service"], "snapshot" | "pageTimes" | "createDirectory">
  readonly sessions: Pick<SessionStore["Service"], "list">
  readonly transcripts: Pick<TranscriptQueries["Service"], "conversationPage">
  readonly position: DailySummaryPosition["Service"]
  readonly handlerItems: Pick<
    AutomationHandlerItems["Service"],
    "prepareHandlerItem" | "settleHandlerItem"
  >
  readonly runItem: HandlerItemRunner
  readonly timezone?: string
}): AutomationRunner => {
  const timezone = services.timezone ?? machineTimeZone()

  const dayMessages = Effect.fn("DailySummary.dayMessages")(function* (
    startMs: number,
    endMs: number
  ) {
    const messages: Array<{ readonly ref: string; readonly text: string }> = []
    let cursor: { readonly at: string; readonly sessionId: string } | undefined
    while (true) {
      const sessions = yield* services.sessions.list({
        scope: "primary",
        sort: "activity",
        includeArchived: true,
        limit: SESSION_PAGE,
        ...(cursor === undefined ? {} : { cursor })
      })
      for (const session of sessions) {
        if (Date.parse(session.lastActivity) < startMs) return messages
        const found: Array<{ readonly ref: string; readonly text: string }> = []
        let before: number | undefined
        while (true) {
          const page = yield* services.transcripts.conversationPage(
            before === undefined
              ? { _tag: "Latest", sessionId: session.sessionId, limit: MESSAGE_PAGE }
              : {
                  _tag: "Before",
                  sessionId: session.sessionId,
                  limit: MESSAGE_PAGE,
                  sequence: before
                }
          )
          for (const record of [...page.records].reverse()) {
            const time = DateTime.toEpochMillis(record.createdAt)
            if (time >= endMs || (record.role !== "user" && record.role !== "assistant")) continue
            if (time < startMs) continue
            const text =
              record.envelope.question_answer !== undefined
                ? ownerText(record.envelope)
                : contentText(record.envelope.content)
            if (text.trim().length === 0) continue
            found.push({
              ref: `${chatHref({ publicRef: session.publicRef })} (message ${record.messageId})`,
              text: `${record.role} at ${DateTime.formatIso(record.createdAt)}: ${text}`
            })
          }
          const first = page.records[0]
          if (
            first === undefined ||
            !page.hasMoreBefore ||
            DateTime.toEpochMillis(first.createdAt) < startMs
          )
            break
          before = first.sequence
        }
        messages.push(...found.reverse())
      }
      const last = sessions.at(-1)
      if (last === undefined || sessions.length < SESSION_PAGE) return messages
      cursor = { at: last.lastActivity, sessionId: last.sessionId }
    }
  })

  const prepareDay = Effect.fn("DailySummary.prepareDay")(function* (
    date: string
  ): Effect.fn.Return<DayPreparation, Error> {
    const start = dayStart(date, timezone)
    const end = dayStart(nextDay(date), timezone)
    const path = `daily/${date}.md`
    const snapshot = yield* services.wiki.snapshot()
    const existing = snapshot.wholeSet.find(
      (page) => page.resource.path.toLowerCase() === path.toLowerCase()
    )
    const folders = recordFolders(snapshot.pages)
    if (existing !== undefined)
      return existing.page.lifecycle === "active" &&
        producingAutomation(folders, existing.resource.path) === DAILY_SUMMARY_AUTOMATION_ID
        ? { kind: "settled" }
        : { kind: "settled", note: `${path} is kept by another writer` }
    const startMs = DateTime.toEpochMillis(start)
    const endMs = DateTime.toEpochMillis(end)
    const reports = snapshot.pages.filter((page) => {
      const kind = pageKind(folders, page.resource.path)
      return (
        page.page.lifecycle === "active" &&
        kind.kind === "record" &&
        kind.folder.producer.kind === "automation" &&
        kind.folder.producer.automationId !== DAILY_SUMMARY_AUTOMATION_ID
      )
    })
    const times = yield* services.wiki.pageTimes(snapshot.head)
    const dayReports = reports.filter((page) => {
      const updated = times.get(page.page.pageId)?.updatedAt
      if (updated === null || updated === undefined) return false
      const at = Date.parse(updated)
      return at >= startMs && at < endMs
    })
    const candidates = [
      ...(yield* dayMessages(startMs, endMs)),
      ...dayReports.map((page) => ({
        ref: `arden:memory/${page.resource.path}`,
        text: `Report ${page.page.title}; version ${page.resource.versionId}; observation period: ${String(page.page.metadata["observation_period"] ?? "unspecified")}\n${page.page.body}`
      }))
    ]
    if (candidates.length === 0) return { kind: "settled" }
    const evidence: Array<string> = []
    const sources: Array<string> = []
    let remaining = EVIDENCE_CHARS
    let shortened = 0
    for (const candidate of candidates) {
      if (remaining <= 0 || sources.length >= EVIDENCE_EXCERPTS) break
      const text = candidate.text.slice(0, Math.min(EXCERPT_CHARS, remaining))
      if (text.length < candidate.text.length) shortened += 1
      evidence.push(`${candidate.ref}\n${text}`)
      sources.push(candidate.ref)
      remaining -= text.length
    }
    const contract = snapshot.pages.find(
      (page) => page.resource.path === "daily/README.md" && page.page.lifecycle === "active"
    )
    if (contract === undefined)
      yield* services.wiki.createDirectory({
        path: "daily",
        body: DAILY_CONTRACT,
        authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
        producerAutomationId: DAILY_SUMMARY_AUTOMATION_ID,
        commit: {
          actor: `Automation ${DAILY_SUMMARY_AUTOMATION_ID}`,
          origin: automationOrigin(DAILY_SUMMARY_AUTOMATION_ID),
          reason: "create Wiki directory daily"
        }
      })
    else if (producingAutomation(folders, contract.resource.path) !== DAILY_SUMMARY_AUTOMATION_ID)
      return yield* Effect.fail(
        new Error(
          "Daily collection needs its producer binding configured; preserved the existing daily collection"
        )
      )
    const messages = candidates.length - dayReports.length
    const keptMessages = Math.min(sources.length, messages)
    const keptReports = sources.length - keptMessages
    const coverage = [
      `Coverage: every owner chat's messages from this day (${messages}) and every report last changed on this day (${dayReports.length}).`,
      `One run reads at most ${EVIDENCE_EXCERPTS} excerpts and ${EVIDENCE_CHARS} characters, ${EXCERPT_CHARS} per excerpt.`,
      sources.length === candidates.length && shortened === 0
        ? "Nothing was left out."
        : `Left out by that limit: ${messages - keptMessages} messages and ${dayReports.length - keptReports} reports; ${shortened} excerpts shortened.`,
      "Reports changed again after this day and unavailable records are not covered. This is not proof of all activity. Report edit dates do not establish event dates."
    ].join(" ")
    return {
      kind: "write",
      markdown: `Destination: ${path}\nObservation period for wiki_publish_report: ${JSON.stringify({ start: DateTime.formatIso(start), end: DateTime.formatIso(end) })} (end exclusive), ${timezone}\nSource refs:\n${markdownValue(sources)}\n${coverage}\n\n${evidence.join("\n\n")}`
    }
  })

  return (job) => {
    const today = localDayOf(job.leasedAt, timezone)
    const notes: Array<string> = []
    return runItemLoop(services, {
      label: "Daily summary",
      kind: "daily",
      next: Effect.fn("DailySummary.next")(function* () {
        const place = yield* services.position.current(dailyStartPosition(job.leasedAt, timezone))
        const settled = place.settledDay
        const date = nextDay(settled)
        if (date >= today) return "idle" as const
        if (place.tries >= TRIES_BEFORE_DAY_SKIPPED) {
          notes.push(
            `daily/${date}.md was not written: its run did not finish in ${TRIES_BEFORE_DAY_SKIPPED} jobs`
          )
          yield* services.position.advance({ from: settled, to: date })
          return "advance" as const
        }
        const prepared = yield* prepareDay(date)
        if (prepared.kind === "settled") {
          if (prepared.note !== undefined) notes.push(prepared.note)
          yield* services.position.advance({ from: settled, to: date })
          return "advance" as const
        }
        yield* services.position.tried(settled)
        return { kind: "daily" as const, date, timezone, markdown: prepared.markdown }
      }),
      commit: (data) => services.position.advance({ from: nextDay(data.date, -1), to: data.date }),
      summary: (item) =>
        [
          item === undefined
            ? "daily summary: no ended day needed a run"
            : `daily summary: ${item.reviewed} day run(s) finished, ${item.skipped} did not`,
          ...notes
        ].join("; "),
      cancelled: "Daily summary cancelled",
      incomplete: "Daily summary stopped before a day was written; that day is tried again next run"
    })(job)
  }
}

const contentText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : (Array.isArray(content) ? content : [])
        .flatMap((part) =>
          Predicate.isObject(part) && part.type === "text" && typeof part.text === "string"
            ? [part.text]
            : []
        )
        .join("\n")

export const dailySummaryHandler: SystemAutomationHandler<"daily_summary"> = {
  spec: {
    automationId: DAILY_SUMMARY_AUTOMATION_ID,
    name: "Daily summary",
    description: "Retain a short daily note from recorded Chats and available reports.",
    prompt: PROMPT_TEXT.dailySummary,
    handler: "daily_summary",
    triggers: [{ type: "time", at: "00:15", days: "daily" }],
    enabled: true,
    cooldownMinutes: null,
    toolScope: "reports",
    contextMode: "fresh",
    chatSession: true,
    manualRun: true,
    runsModel: true,
    rearmOnSeed: false
  },
  item: handlerItemText("daily", (data) => data.markdown),
  run: (services) =>
    makeDailySummaryRunner({
      wiki: services.wiki,
      sessions: services.sessions,
      transcripts: services.transcripts,
      position: services.dailyPosition,
      handlerItems: services.handlerItems,
      runItem: services.runItem
    })
}
