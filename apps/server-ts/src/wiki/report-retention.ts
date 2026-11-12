import { posix } from "node:path"

import { directorySections } from "./collections.js"
import { pageWikiLinks } from "./links.js"
import { pageNameIndex, resolveWikiLinkTarget, type PageRecord } from "./snapshot.js"

/**
 * How long a report directory keeps its dated reports. Read from one line in the directory
 * README's Retention section, so the rule a person reads is the rule the code runs:
 *
 *   Keep: forever
 *   Keep: 30 days
 *   Keep: 30 days, monthly summary
 *
 * A README without such a line keeps everything. Reports are never retired on a guess.
 */
export type ReportRetention =
  | { readonly kind: "forever" }
  | { readonly kind: "days"; readonly days: number; readonly summary: "monthly" | "none" }

const KEEP_LINE = /^[ \t]*(?:[-*][ \t]+)?Keep:[ \t]*(.*)$/imu
const KEEP_DAYS = /^([1-9]\d{0,3})\s+days?(?:,?\s+(?:with\s+)?(?:a\s+)?monthly\s+summary)?\.?$/iu
const KEEP_FOREVER = /^forever\.?$/iu

const keepRule = (retentionSection: string | undefined): string | undefined =>
  KEEP_LINE.exec(retentionSection ?? "")?.[1]?.trim()

const runs = (rule: string): boolean => KEEP_FOREVER.test(rule) || KEEP_DAYS.test(rule)

/** Whether the section states a Keep rule the server can run. New report directories must. */
export const statesReportRetention = (retentionSection: string | undefined): boolean => {
  const rule = keepRule(retentionSection)
  return rule !== undefined && runs(rule)
}

export const KEEP_RULE_FORMS =
  "Keep: forever, Keep: 30 days, or Keep: 30 days, monthly summary (any number of days)"

/**
 * The Keep line as written, when the section has one the server cannot run. Such a line would
 * silently keep everything, so a save that carries one is refused and names it.
 */
export const unreadableKeepRule = (retentionSection: string | undefined): string | undefined => {
  const rule = keepRule(retentionSection)
  return rule === undefined || runs(rule) ? undefined : `Keep: ${rule}`
}

export const parseReportRetention = (retentionSection: string | undefined): ReportRetention => {
  const rule = keepRule(retentionSection)
  const days = rule === undefined ? null : KEEP_DAYS.exec(rule)
  if (rule === undefined || days === null) return { kind: "forever" }
  return {
    kind: "days",
    days: Number(days[1]),
    summary: /monthly\s+summary/iu.test(rule) ? "monthly" : "none"
  }
}

/** One calendar month of dated reports that is past its directory's retention. */
export interface RetentionMonth {
  readonly directory: string
  /** YYYY-MM */
  readonly month: string
  readonly summary:
    | { readonly kind: "none" }
    | { readonly kind: "monthly"; readonly path: string; readonly written: boolean }
  /** Reports to archive: dated, past retention, and linked from no subject page. */
  readonly retire: ReadonlyArray<PageRecord>
  /** Reports past retention that stay because a subject page links to them. */
  readonly linked: ReadonlyArray<PageRecord>
}

/**
 * A monthly summary over this size is refused. Without a limit the summary becomes the copy of
 * the reports it was meant to replace.
 */
export const MONTHLY_SUMMARY_MAX_CHARS = 3_000

const DAY_MS = 86_400_000
const DATED_REPORT = /^(\d{4})-(\d{2})-(\d{2})(?:\D.*)?\.md$/u
const MONTH_SUMMARY = /^\d{4}-\d{2}\.md$/u

const reportDay = (path: string): { readonly month: string; readonly time: number } | undefined => {
  const match = DATED_REPORT.exec(posix.basename(path))
  if (match === null) return undefined
  const [, year, month, day] = match
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day))
  return Number.isNaN(time) ? undefined : { month: `${year}-${month}`, time }
}

export const isMonthlySummaryPath = (path: string): boolean =>
  MONTH_SUMMARY.test(posix.basename(path))

/** Where the monthly summary of a dated report lives, for a path named by date. */
export const monthlySummaryPathOf = (reportPath: string): string | undefined => {
  const day = reportDay(reportPath)
  return day === undefined ? undefined : `${posix.dirname(reportPath)}/${day.month}.md`
}

const isActive = (record: PageRecord): boolean =>
  record.resource.state === "active" && record.page.lifecycle === "active"

const MEMORY_LINK = /arden:memory\/([^\s)>\]]+\.md)/giu

/**
 * Page ids that a subject page outside `directory` links to. A link from another dated record
 * (a daily note, another report) does not count: it cites the report as evidence of that day,
 * and nearly every report has one, so counting it would keep almost everything.
 */
const linkedFromOutside = (
  pages: ReadonlyArray<PageRecord>,
  directory: string
): ReadonlySet<string> => {
  const byId = new Map(pages.map((record) => [record.page.pageId, record] as const))
  const byPath = new Map(
    pages.map((record) => [record.resource.path.toLowerCase(), record.page.pageId] as const)
  )
  const names = pageNameIndex(pages)
  const prefix = `${directory.toLowerCase()}/`
  const linked = new Set<string>()
  for (const record of pages) {
    if (
      !isActive(record) ||
      record.resource.path.toLowerCase().startsWith(prefix) ||
      reportDay(record.resource.path) !== undefined ||
      isMonthlySummaryPath(record.resource.path)
    )
      continue
    for (const token of pageWikiLinks(record.page)) {
      const target = resolveWikiLinkTarget(byId, names, record.page.pageId, token)
      if (target !== null) linked.add(target)
    }
    for (const match of record.page.body.matchAll(MEMORY_LINK)) {
      const target = byPath.get(decodeURI(match[1] ?? "").toLowerCase())
      if (target !== undefined) linked.add(target)
    }
  }
  return linked
}

/**
 * The months of dated reports that are past retention, oldest first, across every report
 * directory (a directory whose README is bound to a producer Automation).
 *
 * A month is due only when its newest report is past retention, so a month is summarized once,
 * as a whole. Only pages named by date are reports: the rolling page, the README and monthly
 * summaries are never retired.
 */
export const dueReportMonths = (
  pages: ReadonlyArray<PageRecord>,
  now: number
): ReadonlyArray<RetentionMonth> => {
  const active = pages.filter(isActive)
  const due: Array<RetentionMonth> = []
  for (const readme of active) {
    const directory = posix.dirname(readme.resource.path)
    if (
      posix.basename(readme.resource.path).toLowerCase() !== "readme.md" ||
      directory === "." ||
      typeof readme.page.metadata["producer_automation_id"] !== "string"
    )
      continue
    const retention = parseReportRetention(directorySections(readme.page.body).get("Retention"))
    if (retention.kind === "forever") continue
    const cutoff = now - retention.days * DAY_MS
    const months = new Map<string, Array<{ readonly record: PageRecord; readonly time: number }>>()
    for (const record of active) {
      if (posix.dirname(record.resource.path) !== directory) continue
      const day = reportDay(record.resource.path)
      if (day === undefined) continue
      months.set(day.month, [...(months.get(day.month) ?? []), { record, time: day.time }])
    }
    const linked = linkedFromOutside(pages, directory)
    for (const [month, reports] of months) {
      if (reports.some((report) => report.time + DAY_MS > cutoff)) continue
      const summaryPath = `${directory}/${month}.md`
      const retire = reports.filter((report) => !linked.has(report.record.page.pageId))
      if (retire.length === 0) continue
      due.push({
        directory,
        month,
        summary:
          retention.summary === "none"
            ? { kind: "none" }
            : {
                kind: "monthly",
                path: summaryPath,
                written: active.some(
                  (record) => record.resource.path.toLowerCase() === summaryPath.toLowerCase()
                )
              },
        retire: retire.map((report) => report.record),
        linked: reports
          .filter((report) => linked.has(report.record.page.pageId))
          .map((report) => report.record)
      })
    }
  }
  return due.sort(
    (left, right) =>
      left.month.localeCompare(right.month) || left.directory.localeCompare(right.directory)
  )
}
