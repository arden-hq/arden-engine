import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { prepareMemorySources } from "../src/memory/retrieval.js"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import type { PageRecord } from "../src/wiki/snapshot.js"

// Made-up pages; nothing here comes from anyone's Memory.

const HASH = "0".repeat(64)

const content = (path: string, body: string, producer?: string): string =>
  formatWikiPage({
    pageId: `id:${path}`,
    title: path,
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: producer === undefined ? {} : { producer_automation_id: producer },
    body
  })

const page = (path: string, body = `About ${path}.`, producer?: string): PageRecord => ({
  resource: { resourceId: `id:${path}`, path, blobId: HASH, state: "active", versionId: HASH },
  page: Effect.runSync(parseWikiPage(content(path, body, producer), `id:${path}`))
})

describe("recall of records", () => {
  const recalled = (pages: ReadonlyArray<PageRecord>, query: string) =>
    (
      prepareMemorySources({
        pages,
        recall: { query, excludedPageIds: new Set() },
        today: "2026-11-14",
        lastChanged: new Map()
      })
        .render(new Map())
        .recall?.(20_000).sources ?? []
    ).flatMap((source) => (source.kind === "recalled" ? [[source.page_id, source.role]] : []))

  it("leaves out a 30-day-old report and recalls a 3-day-old one with the role record", () => {
    const sources = recalled(
      [
        page("daily/README.md", "Daily notes.", "auto-daily"),
        page("daily/2026-10-15.md", "Garden seeds report."),
        page("daily/2026-11-11.md", "Garden seeds report."),
        page("daily/2026-11-12.md", "Nothing much."),
        page("topics/garden.md", "Garden seeds report.")
      ],
      "garden seeds report"
    )
    expect(sources.sort()).toEqual([
      ["id:daily/2026-11-11.md", "record"],
      ["id:topics/garden.md", "knowledge"]
    ])
  })

  it("recalls a folder's newest report and an undated one, however old", () => {
    const sources = recalled(
      [
        page("sources/mail/README.md", "Mail digests.", "auto-mail"),
        page("sources/mail/2026-08-01.md", "Garden seeds report."),
        page("sources/mail/2026-09-01.md", "Garden seeds report."),
        page("sources/mail/updates.md", "Garden seeds report.")
      ],
      "garden seeds report"
    )
    expect(sources.map(([id]) => id)).toEqual([
      "id:sources/mail/2026-09-01.md",
      "id:sources/mail/updates.md"
    ])
  })
})
