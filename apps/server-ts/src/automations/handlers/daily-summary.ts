import { ROLE } from "@arden-hq/std/message-vocabulary"
import { localDayOf, machineTimeZone } from "@arden-hq/std/time"
import { DateTime, Effect, Predicate } from "effect"
import type { SessionStore } from "../../persistence/sessions/store.js"
import type { TranscriptQueries } from "../../persistence/transcript/queries.js"
import type {
  DayActivity,
  DayItem,
  DayTaskEvent
} from "../../persistence/automations/day-activity.js"
import { ownerText } from "../../persistence/transcript/owner-words.js"
import { DAILY_SUMMARY_AUTOMATION_ID } from "../../persistence/automations/model.js"
import type { HandlerItemDataOf } from "../../persistence/automations/handler-item.js"
import { PROMPTS } from "../../prompts/catalog.js"
import { markdownValue } from "../../prompts/format.js"
import type { Wiki } from "../../wiki/service.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../../wiki/authority.js"
import { automationOrigin } from "../../wiki/commit.js"
import { pageKind, producingAutomation, recordFolders } from "../../wiki/collections.js"
import { runItemLoop, type ItemLoopServices } from "../item-loop.js"
import type { AutomationRunner } from "../runner.js"
import type { ReaderPosition } from "../../persistence/reader-position.js"
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
/** The part of `EVIDENCE_CHARS` kept for Tasks and for items, so a busy chat cannot crowd them
 *  out; what they leave unused goes to the chats. On three sampled days of the owner's data every
 *  Task change and every item fit these (2026-11-17). */
const TASK_SHARE = { count: 8, chars: 3_000, each: 400 } as const
const ITEM_SHARE = { count: 10, chars: 2_000, each: 250 } as const
const SESSION_PAGE = 100
const MESSAGE_PAGE = 250

const nextDay = (day: string, days = 1): string =>
  DateTime.formatIsoDate(DateTime.add(DateTime.makeUnsafe(`${day}T00:00:00Z`), { days }))

const dayStart = (day: string, timezone: string): DateTime.Zoned =>
  DateTime.makeZonedUnsafe(`${day}T00:00:00`, { timeZone: timezone, adjustForTimeZone: true })

/** The day before the last ended day: where the position starts, so the first job after an
 * update, or after the owner resumes Daily Summary, writes only the last ended day's page. */
const dailyStartPosition = (nowMs: number, timezone: string): string =>
  nextDay(localDayOf(nowMs, timezone), -2)

export interface ChatExcerpt {
  readonly ref: string
  readonly text: string
  /** The owner's own words, not Arden's reply. */
  readonly owner: boolean
}

/**
 * Picks the day's chat excerpts so every chat is heard: the owner's own messages first, then
 * Arden's replies, each taken one chat at a time and newest first, since a day's outcome is
 * said late. The picked excerpts keep their chat and time order.
 */
export const pickChatExcerpts = (
  chats: ReadonlyArray<ReadonlyArray<ChatExcerpt>>,
  limit: { readonly excerpts: number; readonly chars: number }
): {
  readonly picked: ReadonlyArray<{ readonly ref: string; readonly text: string }>
  readonly shortened: number
} => {
  const kept = new Map<string, string>()
  let remaining = limit.chars
  let shortened = 0
  for (const owner of [true, false]) {
    const queues = chats.map((chat, chatIndex) =>
      chat
        .map((excerpt, index) => ({ excerpt, key: `${chatIndex}:${index}` }))
        .filter(({ excerpt }) => excerpt.owner === owner)
        .reverse()
    )
    for (let round = 0; queues.some((queue) => round < queue.length); round += 1) {
      for (const queue of queues) {
        const next = queue[round]
        if (next === undefined) continue
        if (remaining <= 0 || kept.size >= limit.excerpts) break
        const text = next.excerpt.text.slice(0, Math.min(EXCERPT_CHARS, remaining))
        if (text.length < next.excerpt.text.length) shortened += 1
        kept.set(next.key, text)
        remaining -= text.length
      }
    }
  }
  return {
    picked: chats.flatMap((chat, chatIndex) =>
      chat.flatMap((excerpt, index) => {
        const text = kept.get(`${chatIndex}:${index}`)
        return text === undefined ? [] : [{ ref: excerpt.ref, text }]
      })
    ),
    shortened
  }
}

/** Failed and waiting Tasks first, then finished ones, then new ones. */
const TASK_EVENT_RANK: Readonly<Record<string, number>> = {
  failed: 0,
  stalled: 0,
  blocked: 0,
  on_hold: 0,
  done: 1,
  cancelled: 1,
  unblocked: 1,
  created: 2
}

interface Excerpts {
  readonly lines: ReadonlyArray<{ readonly ref: string; readonly text: string }>
  readonly shortened: number
}

const cut = (
  lines: ReadonlyArray<{ readonly ref: string; readonly text: string }>,
  share: { readonly count: number; readonly chars: number; readonly each: number }
): Excerpts => {
  const kept: Array<{ readonly ref: string; readonly text: string }> = []
  let remaining = share.chars
  let shortened = 0
  for (const line of lines) {
    if (kept.length >= share.count || remaining <= 0) break
    const text = line.text.slice(0, Math.min(share.each, remaining))
    if (text.length < line.text.length) shortened += 1
    kept.push({ ref: line.ref, text })
    remaining -= text.length
  }
  return { lines: kept, shortened }
}

/** One excerpt for each Task that changed, with its changes in time order. */
export const taskExcerpts = (events: ReadonlyArray<DayTaskEvent>): Excerpts => {
  const tasks = new Map<string, Array<DayTaskEvent>>()
  for (const event of events) tasks.set(event.itemId, [...(tasks.get(event.itemId) ?? []), event])
  const rank = (changes: ReadonlyArray<DayTaskEvent>) =>
    Math.min(...changes.map((change) => TASK_EVENT_RANK[change.type] ?? 2))
  return cut(
    [...tasks.values()]
      .toSorted((left, right) => rank(left) - rank(right))
      .flatMap((changes) => {
        const first = changes[0]
        if (first === undefined) return []
        const where = first.spaceName === undefined ? "" : ` in ${first.spaceName}`
        const said = changes
          .map((change) =>
            change.summary === undefined || change.type === "created"
              ? `${change.type} at ${change.at}`
              : `${change.type} at ${change.at}: ${change.summary}`
          )
          .join("; ")
        return [
          {
            ref: `arden:task/${encodeURIComponent(first.itemId)}`,
            text: `Task ${JSON.stringify(first.title)}${where}: ${said}`
          }
        ]
      }),
    TASK_SHARE
  )
}

const itemSender = (item: DayItem): string => {
  if (item.sentByOwner) return ", sent by the user"
  return item.sender === undefined ? "" : ` from ${item.sender}`
}

const itemExcerpts = (items: ReadonlyArray<DayItem>): Excerpts =>
  cut(
    items.map((item) => {
      return {
        ref: `item ${item.itemId}`,
        text: `${item.source} at ${item.receivedAt}${itemSender(item)}: ${item.title}. ${item.snippet}`
      }
    }),
    ITEM_SHARE
  )

type DayPreparation =
  | { readonly kind: "settled"; readonly note?: string }
  | { readonly kind: "write"; readonly markdown: string }

const makeDailySummaryRunner = (
  services: ItemLoopServices & {
    readonly wiki: Pick<Wiki["Service"], "snapshot" | "pageTimes" | "createDirectory">
    readonly sessions: Pick<SessionStore["Service"], "list">
    readonly transcripts: Pick<TranscriptQueries["Service"], "conversationPage" | "ownerWordsIn">
    readonly dayActivity: Pick<DayActivity["Service"], "read">
    readonly position: Pick<ReaderPosition<string>, "start" | "advance">
    readonly timezone?: string
  }
): AutomationRunner => {
  const timezone = services.timezone ?? machineTimeZone()

  const dayMessages = Effect.fn("DailySummary.dayMessages")(function* (
    startMs: number,
    endMs: number
  ) {
    const chats: Array<ReadonlyArray<ChatExcerpt>> = []
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
        if (Date.parse(session.lastActivity) < startMs) return chats
        const found: Array<ChatExcerpt & { readonly messageId: string }> = []
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
            if (time >= endMs || record.role === ROLE.system || record.role === ROLE.developer)
              continue
            if (record.role === ROLE.tool) continue
            if (time < startMs) continue
            const text =
              record.envelope.question_answer !== undefined
                ? ownerText(record.envelope)
                : contentText(record.envelope.content)
            if (text.trim().length === 0) continue
            found.push({
              messageId: record.messageId,
              owner: record.role === ROLE.user,
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
        // A message with the user role is also how a worker's result, a Task notice or a
        // skill's text is stored: only what the owner wrote is their words.
        const owners = yield* services.transcripts.ownerWordsIn(
          session.sessionId,
          found.filter((message) => message.owner).map((message) => message.messageId)
        )
        const kept = found
          .filter((message) => !message.owner || owners.has(message.messageId))
          .reverse()
        if (kept.length > 0) chats.push(kept)
      }
      const last = sessions.at(-1)
      if (last === undefined || sessions.length < SESSION_PAGE) return chats
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
    const chats = yield* dayMessages(startMs, endMs)
    const activity = yield* services.dayActivity.read({
      start: DateTime.formatIso(start),
      end: DateTime.formatIso(end)
    })
    const taskPart = taskExcerpts(activity.taskEvents)
    const itemPart = itemExcerpts(activity.items)
    const tasks = taskPart.lines
    const items = itemPart.lines
    const reportCandidates = dayReports.map((page) => ({
      ref: `arden:memory/${page.resource.path}`,
      text: `Report ${page.page.title}; version ${page.resource.versionId}; observation period: ${String(page.page.metadata["observation_period"] ?? "unspecified")}\n${page.page.body}`
    }))
    const messages = chats.reduce((count, chat) => count + chat.length, 0)
    if (messages + reportCandidates.length + tasks.length + items.length === 0)
      return { kind: "settled" }
    const used = (lines: ReadonlyArray<{ readonly text: string }>) =>
      lines.reduce((chars, line) => chars + line.text.length, 0)
    const chosen = pickChatExcerpts(chats, {
      excerpts: EVIDENCE_EXCERPTS,
      chars: EVIDENCE_CHARS - used(tasks) - used(items)
    })
    const keptReports: Array<{ readonly ref: string; readonly text: string }> = []
    let remaining = EVIDENCE_CHARS - used(tasks) - used(items) - used(chosen.picked)
    let shortened = chosen.shortened + taskPart.shortened + itemPart.shortened
    for (const candidate of reportCandidates) {
      if (remaining <= 0 || chosen.picked.length + keptReports.length >= EVIDENCE_EXCERPTS) break
      const text = candidate.text.slice(0, Math.min(EXCERPT_CHARS, remaining))
      if (text.length < candidate.text.length) shortened += 1
      keptReports.push({ ref: candidate.ref, text })
      remaining -= text.length
    }
    const section = (
      title: string,
      lines: ReadonlyArray<{ readonly ref: string; readonly text: string }>
    ) =>
      lines.length === 0
        ? []
        : [`## ${title}\n\n${lines.map((line) => `${line.ref}\n${line.text}`).join("\n\n")}`]
    const evidence = [
      ...section("Chats", chosen.picked),
      ...section("Reports", keptReports),
      ...section("Tasks (Arden's record of its work)", tasks),
      ...section("Items (mail and other services)", items)
    ]
    const sources = [...chosen.picked, ...keptReports, ...tasks, ...items].map((line) => line.ref)
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
    const taskCount = new Set(activity.taskEvents.map((event) => event.itemId)).size
    const leftOut =
      messages -
      chosen.picked.length +
      (dayReports.length - keptReports.length) +
      (taskCount - tasks.length) +
      (activity.items.length - items.length)
    const coverage = [
      `Coverage: the owner's messages and Arden's replies in every owner chat from this day (${messages}), every report last changed on this day (${dayReports.length}), every Task that changed (${taskCount}) and every item that arrived (${activity.items.length}).`,
      `One run reads at most ${EVIDENCE_EXCERPTS} chat and report excerpts and ${EVIDENCE_CHARS} characters in all, of which up to ${TASK_SHARE.chars} are kept for ${TASK_SHARE.count} Tasks and ${ITEM_SHARE.chars} for ${ITEM_SHARE.count} items.`,
      leftOut === 0 && shortened === 0
        ? "Nothing was left out."
        : `Left out by that limit: ${messages - chosen.picked.length} messages, ${dayReports.length - keptReports.length} reports, ${taskCount - tasks.length} Tasks and ${activity.items.length - items.length} items; ${shortened} excerpts shortened.`,
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
    const settle = (data: HandlerItemDataOf<"daily">) =>
      services.position.advance({ expected: nextDay(data.date, -1), next: data.date })
    return runItemLoop(services, {
      label: "Daily summary",
      kind: "daily",
      next: Effect.fn("DailySummary.next")(function* () {
        const settled = yield* services.position.start(dailyStartPosition(job.leasedAt, timezone))
        const date = nextDay(settled)
        if (date >= today) return "idle" as const
        const prepared = yield* prepareDay(date)
        if (prepared.kind === "settled") {
          if (prepared.note !== undefined) notes.push(prepared.note)
          yield* services.position.advance({ expected: settled, next: date })
          return "advance" as const
        }
        return { kind: "daily" as const, date, timezone, markdown: prepared.markdown }
      }),
      commit: settle,
      skip: (data) => settle(data).pipe(Effect.as(`daily/${data.date}.md`)),
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
    description:
      "Retain a short daily note from recorded Chats, Tasks, items and available reports.",
    prompt: PROMPTS.dailySummary,
    handler: "daily_summary",
    triggers: [{ type: "time", at: "00:15", days: "daily" }],
    enabled: true,
    cooldownMinutes: null,
    toolScope: "reports",
    contextMode: "fresh",
    chatSession: true,
    manualRun: true,
    promptEdit: "owner",
    triggerScope: "any",
    rearmOnSeed: false
  },
  item: handlerItemText("daily", (data) => data.markdown),
  run: (services) =>
    makeDailySummaryRunner({
      wiki: services.wiki,
      sessions: services.sessions,
      transcripts: services.transcripts,
      dayActivity: services.dayActivity,
      position: services.positions.dailySummary,
      handlerItems: services.handlerItems,
      runItem: services.runItem
    })
}
