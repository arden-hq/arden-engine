import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { prepareMemorySources, recallCandidates } from "../src/memory/retrieval.js"
import {
  changedAgo,
  lastChangedLine,
  lastChangedLines,
  PAGE_AGE_RULE
} from "../src/wiki/page-age.js"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import type { RunPage } from "../src/wiki/snapshot.js"
import { runPage } from "./kit.js"

const HASH = "0".repeat(64)
const NOW = new Date("2026-11-13T12:00:00Z").getTime()

const page = (path: string, title: string, body: string): RunPage => {
  const pageId = `id:${path}`
  return runPage({
    resource: { resourceId: pageId, path, blobId: HASH, state: "active", versionId: HASH },
    page: Effect.runSync(
      parseWikiPage(
        formatWikiPage({
          pageId,
          title,
          aliases: [],
          lifecycle: "active",
          redirectTo: null,
          metadata: {},
          body
        }),
        pageId
      )
    )
  })
}

describe("page age", () => {
  it("counts calendar days, so the age agrees with the day shown", () => {
    expect([
      changedAgo("2026-11-13T00:10:00Z", NOW),
      changedAgo("2026-11-12T23:50:00Z", NOW),
      changedAgo("2026-09-15T01:39:16Z", NOW),
      changedAgo(null, NOW),
      changedAgo("not a date", NOW)
    ]).toEqual(["today", "1 day ago", "59 days ago", undefined, undefined])
  })

  it("names the day and the age in one line", () => {
    expect(lastChangedLine("2026-09-15T01:39:16Z", NOW)).toBe(
      "Last changed: 2026-09-15 (59 days ago)"
    )
  })

  it("a page recalled into a chat carries its age, and the chat is told what the age means", () => {
    const elicit = page(
      "areas/career/applications/elicit.md",
      "Elicit",
      "Status: Applied. Monitor for a reply."
    )
    const undated = page("areas/career/applications/cohere.md", "Cohere", "Status: Applied.")
    const recall = prepareMemorySources({
      pages: [elicit, undated],
      recall: recallCandidates({
        pages: [elicit, undated],
        query: "elicit cohere application status applied",
        today: "2026-11-14",
        sentElsewhere: new Set()
      }),
      lastChanged: lastChangedLines(
        new Map([
          [elicit.page.pageId, { createdAt: null, updatedAt: "2026-09-15T01:39:16Z" }],
          [undated.page.pageId, { createdAt: null, updatedAt: null }]
        ]),
        NOW
      )
    })
      .render(new Map())
      .recall?.(30_000)
    const text = recall?.text ?? ""
    const block = (title: string): string => text.split(`### ${title}`)[1]?.split("###")[0] ?? ""
    expect(text).toContain(PAGE_AGE_RULE)
    expect(block("Elicit")).toContain("Last changed: 2026-09-15 (59 days ago)")
    expect(block("Cohere")).not.toContain("Last changed")
  })
})
