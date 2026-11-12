import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import { Clock, Effect } from "effect"
import { randomUUID } from "node:crypto"
import { posix } from "node:path"

import { directorySections } from "./collections.js"
import {
  archivePage,
  commitWiki,
  createPage,
  updatePage,
  type WikiPageOperation
} from "./commit.js"
import { mapRevisionError, type WikiError } from "./errors.js"
import { formatWikiPage } from "./page.js"
import { dueReportMonths, type RetentionMonth } from "./report-retention.js"
import { followRedirect, loadSnapshot, type PageRecord, type Snapshot } from "./snapshot.js"

/** Commit origin of a retention archive. Wiki Maintenance skips it: nothing new was claimed. */
export const REPORT_RETENTION_ORIGIN = "memory.report-retention"

/** The built-in Automation that writes monthly summaries and runs the archive. */
export const REPORT_RETENTION_AUTOMATION = "builtin-report-retention"

/**
 * How many reports one model run summarizes. A month with more is summarized in parts: each run
 * folds its reports into the same page and they are archived before the next part starts. A
 * whole busy month does not fit in one run.
 */
export const REPORT_SUMMARY_PART = 30

export type ReportRetentionStep =
  | { readonly kind: "idle" }
  | {
      readonly kind: "retired"
      readonly directory: string
      readonly month: string
      readonly reports: number
    }
  | {
      readonly kind: "summarize"
      readonly directory: string
      readonly month: string
      readonly summaryPath: string
      readonly pageIds: ReadonlyArray<string>
      readonly markdown: string
    }

export type ReportPartResult =
  | { readonly kind: "retired"; readonly reports: number }
  /** The month has no summary page yet, so its reports stay. */
  | { readonly kind: "no_summary" }

export interface WikiReportRetentionMethods {
  /** Archive the oldest month that needs no summary, or describe the next part to summarize. */
  readonly stepReportRetention: () => Effect.Effect<ReportRetentionStep, WikiError>
  /**
   * Archive one summarized part of a month. With `summary: "skip"` the reports are archived
   * although no summary covers them, and the month's page says so.
   */
  readonly retireReportPart: (input: {
    readonly directory: string
    readonly month: string
    readonly pageIds: ReadonlyArray<string>
    readonly summary: "required" | "skip"
  }) => Effect.Effect<ReportPartResult, WikiError>
}

const size = (record: PageRecord): number => record.page.body.length

const byPath = (left: PageRecord, right: PageRecord): number =>
  left.resource.path.localeCompare(right.resource.path)

const summaryPage = (snapshot: Snapshot, path: string): PageRecord | undefined =>
  snapshot.pages.find(
    (record) =>
      record.resource.state === "active" &&
      record.page.lifecycle === "active" &&
      record.resource.path.toLowerCase() === path.toLowerCase()
  )

const summaryBrief = (
  snapshot: Snapshot,
  month: RetentionMonth,
  part: ReadonlyArray<PageRecord>,
  summary: { readonly path: string; readonly written: boolean }
): string => {
  const readme = snapshot.pages.find(
    (record) => record.resource.path.toLowerCase() === `${month.directory}/readme.md`.toLowerCase()
  )
  const purpose = readme === undefined ? "" : directorySections(readme.page.body).get("Purpose")
  const later = month.retire.length - part.length
  const list = (records: ReadonlyArray<PageRecord>): string =>
    records.map((record) => `- ${record.resource.path} (${size(record)} characters)`).join("\n")
  return [
    `Report directory: ${month.directory}`,
    `Month: ${month.month}`,
    summary.written
      ? `The monthly summary exists at ${summary.path} and covers earlier reports of this month. Read it, then rewrite it so it also covers the reports below.`
      : `The monthly summary does not exist yet. Create it at exactly: ${summary.path}`,
    ...(later === 0
      ? []
      : [`${later} more reports of this month come in later runs. Leave room for them.`]),
    ...(purpose ? [`What this directory is for: ${purpose}`] : []),
    `## Reports that will be archived after this run (${part.length})`,
    list(part),
    ...(month.linked.length === 0
      ? []
      : [
          `## Reports of this month that stay, because a subject page links to them (${month.linked.length})`,
          "You do not need to read them. Link to one where it helps.",
          list(month.linked)
        ])
  ].join("\n\n")
}

const reportDate = (record: PageRecord): string => posix.basename(record.resource.path).slice(0, 10)

/** The line that stands in for a summary nobody could write. */
const unsummarizedNote = (records: ReadonlyArray<PageRecord>): string => {
  const sorted = [...records].sort(byPath)
  const first = sorted[0]
  const last = sorted.at(-1)
  const span =
    first === undefined || last === undefined ? "" : `, ${reportDate(first)} to ${reportDate(last)}`
  return `No summary was written for ${records.length} reports${span}. They are archived and can be restored.`
}

export const makeWikiReportRetentionMethods = (
  repository: ManagedFileRepositoryShape
): WikiReportRetentionMethods => {
  const dueMonths = Effect.fn("WikiReportRetention.dueMonths")(function* () {
    const snapshot = yield* loadSnapshot(repository, "archive")
    const now = yield* Clock.currentTimeMillis
    return { snapshot, months: dueReportMonths(snapshot.pages, now) }
  })

  const archive = (
    snapshot: Snapshot,
    month: RetentionMonth,
    reports: ReadonlyArray<PageRecord>,
    first: ReadonlyArray<WikiPageOperation> = []
  ) => {
    // A redirect whose target is archived would point nowhere, so it goes with its report.
    const retired = new Set(reports.map((record) => record.page.pageId))
    const byId = new Map(snapshot.pages.map((record) => [record.page.pageId, record] as const))
    const redirects = snapshot.pages.filter((record) => {
      if (record.resource.state !== "active" || record.page.lifecycle !== "redirect") return false
      const target = followRedirect(byId, record.page.pageId)
      return target !== null && retired.has(target)
    })
    return commitWiki(
      repository,
      {
        expectedRevision: snapshot.head,
        actor: "system:report-retention",
        origin: { kind: "system", name: REPORT_RETENTION_ORIGIN },
        reason: `Archive ${reports.length} reports of ${month.month} in ${month.directory} past retention`
      },
      [...first, ...[...reports, ...redirects].map((record) => archivePage(record.resource))]
    ).pipe(
      Effect.mapError(mapRevisionError("archive")),
      Effect.as({ kind: "retired", reports: reports.length } as const)
    )
  }

  const noteUnsummarized = (
    snapshot: Snapshot,
    month: RetentionMonth,
    path: string,
    reports: ReadonlyArray<PageRecord>
  ): WikiPageOperation => {
    const note = unsummarizedNote(reports)
    const existing = summaryPage(snapshot, path)
    if (existing !== undefined) {
      return updatePage(
        existing.resource,
        formatWikiPage({
          pageId: existing.page.pageId,
          title: existing.page.title,
          aliases: existing.page.aliases,
          lifecycle: existing.page.lifecycle,
          redirectTo: existing.page.redirectTo,
          metadata: existing.page.metadata,
          body: `${existing.page.body.trimEnd()}\n\n${note}\n`
        })
      )
    }
    const pageId = randomUUID()
    return createPage(
      pageId,
      path,
      formatWikiPage({
        pageId,
        title: `${posix.basename(month.directory)} ${month.month}`,
        aliases: [],
        lifecycle: "active",
        redirectTo: null,
        metadata: {},
        body: `${note}\n`
      })
    )
  }

  return {
    stepReportRetention: Effect.fn("WikiReportRetention.step")(function* () {
      const { snapshot, months } = yield* dueMonths()
      const month = months[0]
      if (month === undefined) return { kind: "idle" } as const
      if (month.summary.kind === "monthly") {
        const part = [...month.retire].sort(byPath).slice(0, REPORT_SUMMARY_PART)
        return {
          kind: "summarize",
          directory: month.directory,
          month: month.month,
          summaryPath: month.summary.path,
          pageIds: part.map((record) => record.page.pageId),
          markdown: summaryBrief(snapshot, month, part, month.summary)
        } as const
      }
      const archived = yield* archive(snapshot, month, month.retire)
      return {
        kind: "retired",
        directory: month.directory,
        month: month.month,
        reports: archived.reports
      } as const
    }),
    retireReportPart: Effect.fn("WikiReportRetention.retirePart")(function* (input) {
      const { snapshot, months } = yield* dueMonths()
      const month = months.find(
        (candidate) => candidate.directory === input.directory && candidate.month === input.month
      )
      const wanted = new Set(input.pageIds)
      const reports = (month?.retire ?? []).filter((record) => wanted.has(record.page.pageId))
      if (month === undefined || reports.length === 0) return { kind: "retired", reports: 0 }
      if (month.summary.kind === "none") return yield* archive(snapshot, month, reports)
      if (input.summary === "skip") {
        return yield* archive(snapshot, month, reports, [
          noteUnsummarized(snapshot, month, month.summary.path, reports)
        ])
      }
      if (!month.summary.written) return { kind: "no_summary" }
      return yield* archive(snapshot, month, reports)
    })
  }
}
