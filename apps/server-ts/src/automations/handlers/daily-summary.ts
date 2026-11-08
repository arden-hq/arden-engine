import { machineTimeZone } from "@arden-hq/std/time"
import { DateTime, Effect, Predicate } from "effect"
import type { SessionStore } from "../../persistence/sessions/store.js"
import type { TranscriptQueries } from "../../persistence/transcript/queries.js"
import { ownerText } from "../../persistence/transcript/owner-words.js"
import {
  jobHandlerItem,
  type AutomationJobLease,
  type AutomationJobResult
} from "../../persistence/automations/store.js"
import { AutomationId } from "../../persistence/automations/model.js"
import type { AutomationHandlerItems } from "../../persistence/automations/handler-items.js"
import { PROMPT_TEXT } from "../../prompts/catalog.js"
import { markdownValue } from "../../prompts/format.js"
import type { Wiki } from "../../wiki/service.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../../wiki/authority.js"
import type { HandlerItemRunner } from "../handler-item-run.js"
import { jobResult, type AutomationRunner } from "../runner.js"
import { handlerItemText, type SystemAutomationHandler } from "../system-handler.js"

const DAILY_SUMMARY_AUTOMATION_ID = AutomationId.make("builtin-daily-summary")

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

const makeDailySummaryRunner = (services: {
  readonly wiki: Pick<Wiki["Service"], "snapshot" | "listChanges" | "createDirectory">
  readonly sessions: Pick<SessionStore["Service"], "list">
  readonly transcripts: Pick<TranscriptQueries["Service"], "conversationPage">
  readonly handlerItems: Pick<
    AutomationHandlerItems["Service"],
    "prepareHandlerItem" | "settleHandlerItem"
  >
  readonly runItem: HandlerItemRunner
  readonly timezone?: string
}): AutomationRunner =>
  Effect.fn("DailySummaryRunner")(function* (
    job: AutomationJobLease
  ): Effect.fn.Return<AutomationJobResult, Error> {
    let item = jobHandlerItem(job.payload)
    const sessionId = item?.input.sessionId ?? job.payload.sessionId
    if (sessionId === null) throw new Error("Daily summary has no Chat session")
    const result = (
      outcome: "finished" | "no_change" | "failed",
      detail: string,
      error: string | null = null
    ): AutomationJobResult => {
      const run = {
        chatRunId: item?.runId ?? item?.previousRunId ?? null,
        chatSessionId: sessionId
      }
      return outcome === "failed"
        ? jobResult.failed(error, detail, run)
        : jobResult.completed(outcome, detail, run)
    }
    if (item?.phase === "settled")
      return result(
        item.failure === null ? "finished" : "failed",
        "Daily summary already settled",
        item.failure
      )
    if (item === undefined) {
      const timezone = services.timezone ?? machineTimeZone()
      const end = DateTime.makeUnsafe(job.leasedAt).pipe(
        DateTime.setZoneNamedUnsafe(timezone),
        DateTime.startOf("day")
      )
      const start = DateTime.subtract(end, { days: 1 })
      const date = DateTime.formatIsoDate(start)
      const path = `daily/${date}.md`
      const snapshot = yield* services.wiki.snapshot()
      const existing = snapshot.pages.find(
        (page) => page.resource.path.toLowerCase() === path.toLowerCase()
      )
      if (existing !== undefined) {
        if (
          existing.page.lifecycle === "active" &&
          existing.page.metadata["producer_automation_id"] === DAILY_SUMMARY_AUTOMATION_ID
        )
          return result("no_change", `Daily summary already exists: ${path}`)
        return result(
          "failed",
          `Daily summary destination is occupied: ${path}`,
          "Preserved an existing record owned by another writer"
        )
      }
      const startMs = DateTime.toEpochMillis(start)
      const endMs = DateTime.toEpochMillis(end)
      const evidence: Array<string> = []
      const sources: Array<string> = []
      let remaining = 16_000
      const append = (ref: string, body: string) => {
        if (remaining <= 0 || sources.length >= 30) return
        const text = body.slice(0, Math.min(2_000, remaining))
        if (text.trim().length === 0) return
        evidence.push(`${ref}\n${text}`)
        sources.push(ref)
        remaining -= text.length
      }
      const sessions = yield* services.sessions.list({
        scope: "primary",
        sort: "activity",
        limit: 20
      })
      for (const session of sessions) {
        const page = yield* services.transcripts.conversationPage({
          _tag: "Latest",
          sessionId: session.sessionId,
          limit: 80
        })
        for (const record of page.records) {
          const time = DateTime.toEpochMillis(record.createdAt)
          if (
            time < startMs ||
            time >= endMs ||
            (record.role !== "user" && record.role !== "assistant")
          )
            continue
          const text =
            record.envelope.question_answer !== undefined
              ? ownerText(record.envelope)
              : contentText(record.envelope.content)
          if (text.trim().length === 0) continue
          append(
            `arden:session/${session.publicRef} (message ${record.messageId})`,
            `${record.role} at ${DateTime.formatIso(record.createdAt)}: ${text}`
          )
        }
      }
      const changes = yield* services.wiki.listChanges({
        since: DateTime.formatIso(start),
        offset: 0,
        limit: 100
      })
      const latestChange = new Map<string, number>()
      for (const entry of changes.entries) {
        const timestamp = DateTime.toEpochMillis(DateTime.makeUnsafe(entry.timestamp))
        for (const change of entry.changes) {
          for (const changedPath of [change.path, change.beforePath, change.afterPath]) {
            if (changedPath === null) continue
            const previous = latestChange.get(changedPath)
            if (previous === undefined || timestamp > previous)
              latestChange.set(changedPath, timestamp)
          }
        }
      }
      const paths = new Set(
        [...latestChange]
          .filter(([, time]) => time >= startMs && time < endMs)
          .map(([changedPath]) => changedPath)
      )
      for (const page of snapshot.pages
        .filter(
          (page) =>
            paths.has(page.resource.path) &&
            page.page.lifecycle === "active" &&
            typeof page.page.metadata["producer_automation_id"] === "string" &&
            page.page.metadata["producer_automation_id"] !== DAILY_SUMMARY_AUTOMATION_ID &&
            !page.resource.path.toLowerCase().endsWith("/readme.md")
        )
        .slice(0, 6)) {
        append(
          `arden:memory/${page.resource.path}`,
          `Report ${page.page.title}; version ${page.resource.versionId}; observation period: ${String(page.page.metadata["observation_period"] ?? "unspecified")}\n${page.page.body}`
        )
      }
      if (evidence.length === 0)
        return jobResult.withoutRun(
          "no_input",
          "No evidence found within the bounded daily scan; no note created"
        )
      const contract = snapshot.pages.find(
        (page) => page.resource.path === "daily/README.md" && page.page.lifecycle === "active"
      )
      if (contract === undefined)
        yield* services.wiki.createDirectory({
          path: "daily",
          body: DAILY_CONTRACT,
          authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
          producerAutomationId: DAILY_SUMMARY_AUTOMATION_ID
        })
      else if (contract.page.metadata["producer_automation_id"] !== DAILY_SUMMARY_AUTOMATION_ID)
        return result(
          "failed",
          "Daily collection needs its producer binding configured",
          "Preserved the existing daily collection"
        )
      item = yield* services.handlerItems.prepareHandlerItem(job, {
        sessionId,
        name: job.payload.name,
        instructions: job.payload.prompt,
        data: {
          kind: "daily",
          date,
          timezone,
          markdown: `Destination: ${path}\nObservation period for wiki_publish_report: ${JSON.stringify({ start: DateTime.formatIso(start), end: DateTime.formatIso(end) })} (end exclusive), ${timezone}\nSource refs:\n${markdownValue(sources)}\nCoverage: bounded scan of up to 20 current primary Chats, latest 80 messages each, 100 recent Wiki commits and 6 reports; at most 30 excerpts / 16000 characters. Archived Chats, unavailable records, and reports revised after this day are not covered. This is not proof of all activity. Report edit dates do not establish event dates.\n\n${evidence.join("\n\n")}`
        }
      })
    }
    if (item.input.data.kind !== "daily")
      throw new Error("Daily summary received another handler's item")
    const outcome = yield* services.runItem(job, item)
    item = yield* services.handlerItems.settleHandlerItem(job, outcome.item)
    if (outcome.state !== "done" && outcome.state !== "nothing_to_do")
      return result(
        "failed",
        outcome.result ?? "Daily summary did not complete",
        outcome.detail ?? outcome.state
      )
    return result(
      outcome.state === "done" ? "finished" : "no_change",
      outcome.result ?? "Daily summary completed"
    )
  })

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
      handlerItems: services.handlerItems,
      runItem: services.runItem
    })
}
