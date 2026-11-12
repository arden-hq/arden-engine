import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import {
  dueReportMonths,
  monthlySummaryPathOf,
  parseReportRetention,
  statesReportRetention,
  unreadableKeepRule
} from "../src/wiki/report-retention.js"
import type { PageRecord } from "../src/wiki/snapshot.js"

const HASH = "0".repeat(64)
const NOW = Date.UTC(2026, 10, 12)

const page = (path: string, body: string, metadata: Record<string, string> = {}): PageRecord => {
  const pageId = `id:${path}`
  return {
    resource: { resourceId: pageId, path, blobId: HASH, state: "active", versionId: HASH },
    page: Effect.runSync(
      parseWikiPage(
        formatWikiPage({
          pageId,
          title: path,
          aliases: [],
          lifecycle: "active",
          redirectTo: null,
          metadata,
          body
        }),
        pageId
      )
    )
  }
}

const readme = (directory: string, retention: string): PageRecord =>
  page(`${directory}/README.md`, `## Purpose\n\nReports.\n\n## Retention\n\n${retention}\n`, {
    producer_automation_id: "automation-1"
  })

const paths = (records: ReadonlyArray<PageRecord>): ReadonlyArray<string> =>
  records.map((record) => record.resource.path)

describe("report retention rule", () => {
  it("reads one Keep line and keeps everything when there is none", () => {
    expect(parseReportRetention("Keep dated reports as historical evidence.")).toEqual({
      kind: "forever"
    })
    expect(parseReportRetention(undefined)).toEqual({ kind: "forever" })
    expect(parseReportRetention("Keep: forever")).toEqual({ kind: "forever" })
    expect(parseReportRetention("Old reports go.\n\nKeep: 30 days")).toEqual({
      kind: "days",
      days: 30,
      summary: "none"
    })
    expect(parseReportRetention("- Keep: 14 days, monthly summary.")).toEqual({
      kind: "days",
      days: 14,
      summary: "monthly"
    })
    // A rule the code cannot read keeps everything rather than guessing.
    expect(parseReportRetention("Keep: a while")).toEqual({ kind: "forever" })
  })

  it("accepts a new report directory only with a rule the server can run", () => {
    expect(
      ["Keep: forever", "Keep: 30 days", "Keep: 30 days, monthly summary"].map(
        statesReportRetention
      )
    ).toEqual([true, true, true])
    expect(
      [undefined, "Keep dated reports as evidence.", "Keep: a while"].map(statesReportRetention)
    ).toEqual([false, false, false])
  })
})

describe("a Keep rule the server cannot run", () => {
  it("is named, so a save can refuse it instead of keeping everything in silence", () => {
    expect(
      ["Keep: 1 month", "Keep: 30d", "Keep: 30 days, weekly summary", "Keep: 0 days", "Keep:"].map(
        unreadableKeepRule
      )
    ).toEqual([
      "Keep: 1 month",
      "Keep: 30d",
      "Keep: 30 days, weekly summary",
      "Keep: 0 days",
      "Keep: "
    ])
  })

  it("leaves prose and readable rules alone", () => {
    expect(
      [
        undefined,
        "Keep dated reports as evidence.",
        "Keep: forever",
        "Keep: 30  days",
        "keep: 14 days with a monthly summary."
      ].map(unreadableKeepRule)
    ).toEqual([undefined, undefined, undefined, undefined, undefined])
  })
})

describe("the month a dated report belongs to", () => {
  it("names the monthly summary beside the report", () => {
    expect(
      ["sources/email/2026-09-03T10-00.md", "sources/email/updates.md", "areas/career.md"].map(
        monthlySummaryPathOf
      )
    ).toEqual(["sources/email/2026-09.md", undefined, undefined])
  })
})

describe("months of reports past retention", () => {
  const pages = [
    readme("sources/email", "Keep: 30 days, monthly summary"),
    page(
      "sources/email/updates.md",
      "Rolling briefing. [[sources/email/2026-09-03T10-00.md|latest]]"
    ),
    page("sources/email/2026-09-03T10-00.md", "September report."),
    page("sources/email/2026-09-20T10-00.md", "Linked September report."),
    page("sources/email/2026-10-10T10-00.md", "Old October report."),
    page("sources/email/2026-10-20T10-00.md", "October report inside retention."),
    page("areas/career.md", "See [[sources/email/2026-09-20T10-00.md|the offer email]]."),
    readme("sources/coast", "Keep dated reports indefinitely."),
    page("sources/coast/2026-07-31.md", "Coast report.")
  ]

  it("retires a whole past month, keeps linked reports, and leaves a partly recent month", () => {
    const due = dueReportMonths(pages, NOW)
    expect(
      due.map((month) => ({
        directory: month.directory,
        month: month.month,
        summary: month.summary,
        retire: paths(month.retire),
        linked: paths(month.linked)
      }))
    ).toEqual([
      {
        directory: "sources/email",
        month: "2026-09",
        summary: { kind: "monthly", path: "sources/email/2026-09.md", written: false },
        retire: ["sources/email/2026-09-03T10-00.md"],
        linked: ["sources/email/2026-09-20T10-00.md"]
      }
    ])
  })

  it("sees a monthly summary that is already written, and never retires it", () => {
    const withSummary = [...pages, page("sources/email/2026-09.md", "September summary.")]
    expect(dueReportMonths(withSummary, NOW).map((month) => month.summary)).toEqual([
      { kind: "monthly", path: "sources/email/2026-09.md", written: true }
    ])
  })

  it("keeps a month due while a report of it is still active, so a late one joins the summary", () => {
    const unlinkedLater = [
      ...pages.filter((record) => record.resource.path !== "areas/career.md"),
      page("sources/email/2026-09.md", "September summary.")
    ]
    expect(
      dueReportMonths(unlinkedLater, NOW).map((month) => ({
        summary: month.summary,
        retire: paths(month.retire)
      }))
    ).toEqual([
      {
        summary: { kind: "monthly", path: "sources/email/2026-09.md", written: true },
        retire: ["sources/email/2026-09-03T10-00.md", "sources/email/2026-09-20T10-00.md"]
      }
    ])
  })

  it("counts an arden:memory link from a subject page, but not a link from a dated note", () => {
    const fromDaily = page(
      "daily/2026-09-04.md",
      "[mail](arden:memory/sources/email/2026-09-03T10-00.md)"
    )
    expect(
      dueReportMonths([...pages, fromDaily], NOW).flatMap((month) => paths(month.retire))
    ).toEqual(["sources/email/2026-09-03T10-00.md"])
    const fromSubject = page(
      "projects/arden.md",
      "[mail](arden:memory/sources/email/2026-09-03T10-00.md)"
    )
    expect(dueReportMonths([...pages, fromSubject], NOW)).toEqual([])
  })
})
