import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { prepareMemorySources, recallCandidates } from "../src/memory/retrieval.js"
import { openMemoryTurn } from "../src/memory/service.js"
import type { SessionQueries } from "../src/persistence/sessions/queries.js"
import type { SpaceStore } from "../src/persistence/spaces/store.js"
import { formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import type { Wiki } from "../src/wiki/service.js"
import { snapshotOf, type PageRecord } from "../src/wiki/snapshot.js"
import { partialService } from "./kit.js"

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
        recall: recallCandidates({ pages, query, today: "2026-11-14", sentElsewhere: new Set() }),
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

  it("recalls a report 14 days old and leaves out one 15 days old", () => {
    const sources = recalled(
      [
        page("daily/README.md", "Daily notes.", "auto-daily"),
        page("daily/2026-10-30.md", "Garden seeds report."),
        page("daily/2026-10-31.md", "Garden seeds report."),
        page("daily/2026-11-13.md", "Nothing much.")
      ],
      "garden seeds report"
    )
    expect(sources).toEqual([["id:daily/2026-10-31.md", "record"]])
  })

  it("keeps records too old to recall out of the search by meaning, so they take none of its places", async () => {
    let excluded: ReadonlyArray<string> = []
    const pages = [
      page("daily/README.md", "Daily notes.", "auto-daily"),
      page("daily/2020-01-01.md", "Garden seeds report."),
      page("daily/2020-02-01.md", "Garden seeds report."),
      page("topics/garden.md", "Garden seeds report.")
    ]
    const turn = await Effect.runPromise(
      openMemoryTurn({
        wiki: partialService<Wiki["Service"]>("Wiki", {
          snapshot: () => Effect.succeed(snapshotOf("head", pages)),
          pageTimes: () => Effect.succeed(new Map())
        }),
        embeddings: {
          search: (_snapshot, _query, excludedPageIds) => {
            excluded = [...(excludedPageIds ?? [])].sort()
            return Effect.succeed([])
          }
        },
        sessions: partialService<SessionQueries["Service"]>("SessionQueries", {}),
        spaces: partialService<SpaceStore["Service"]>("SpaceStore", {})
      })
    )
    if (turn === undefined) throw new Error("Memory was not opened")
    await Effect.runPromise(
      turn.sources({
        sessionId: "session-1",
        recall: { query: "garden seeds report", excludePageIds: ["id:topics/garden.md"] }
      })
    )
    expect(excluded).toEqual(["id:daily/2020-01-01.md", "id:topics/garden.md"])
  })

  it("hands the one candidate set to both searches, so neither chooses a page the other may not", async () => {
    let excluded: ReadonlyArray<string> = []
    const pages = [
      page("me.md", "Garden seeds report."),
      page("daily/README.md", "Daily notes.", "auto-daily"),
      page("daily/2020-01-01.md", "Garden seeds report."),
      page("daily/2020-02-01.md", "Garden seeds report."),
      page("topics/garden.md", "Garden seeds report.")
    ]
    const turn = await Effect.runPromise(
      openMemoryTurn({
        wiki: partialService<Wiki["Service"]>("Wiki", {
          snapshot: () => Effect.succeed(snapshotOf("head", pages)),
          pageTimes: () => Effect.succeed(new Map())
        }),
        embeddings: {
          search: (_snapshot, _query, excludedPageIds) => {
            excluded = [...(excludedPageIds ?? [])].sort()
            return Effect.succeed(
              pages
                .filter((record) => excludedPageIds?.has(record.page.pageId) !== true)
                .map((record) => ({ pageId: record.page.pageId, chunkText: "Garden.", score: 0.5 }))
            )
          }
        },
        sessions: partialService<SessionQueries["Service"]>("SessionQueries", {}),
        spaces: partialService<SpaceStore["Service"]>("SpaceStore", {})
      })
    )
    if (turn === undefined) throw new Error("Memory was not opened")
    const sources = await Effect.runPromise(
      turn.sources({ sessionId: "session-1", recall: { query: "garden seeds report" } })
    )
    const recalled = (sources.recall?.(20_000).sources ?? []).flatMap((source) =>
      source.kind === "recalled" ? [source.page_id] : []
    )
    expect(excluded).toEqual(["id:daily/2020-01-01.md", "id:me.md"])
    expect(recalled.sort()).toEqual([
      "id:daily/2020-02-01.md",
      "id:daily/README.md",
      "id:topics/garden.md"
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
