import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { pageKind, recordFolders } from "../src/wiki/collections.js"
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

describe("record or knowledge", () => {
  const pages = [
    page("daily/README.md", "Daily notes.", "auto-daily"),
    page("daily/2026-11-01.md"),
    page("daily/2026-02-30.md"),
    page("sources/README.md"),
    page("sources/mail/README.md", "Mail digests.", "auto-mail"),
    page("sources/mail/2026-10-01T10-00.md", "A digest.", "auto-mail"),
    page("sources/mail/updates.md"),
    page("topics/garden.md"),
    page("imported/README.md"),
    page("imported/codex/README.md"),
    page("imported/codex/2024-01-01-notes.md")
  ]
  const folders = recordFolders(pages)
  const kindOf = (path: string) => {
    const kind = pageKind(folders, path)
    switch (kind.kind) {
      case "knowledge":
        return "knowledge"
      case "contract":
        return `contract of ${kind.folder.directory}`
      case "record":
        return `record of ${kind.folder.directory}, day ${kind.day ?? "none"}`
    }
  }

  it("decides by the folder, so an unmarked dated page in a producer folder is a record", () => {
    expect(
      Object.fromEntries(
        [...pages.map((record) => record.resource.path), "DAILY/2026-11-02.md"].map((path) => [
          path,
          kindOf(path)
        ])
      )
    ).toEqual({
      "daily/README.md": "contract of daily",
      "daily/2026-11-01.md": "record of daily, day 2026-11-01",
      "daily/2026-02-30.md": "record of daily, day none",
      "sources/README.md": "knowledge",
      "sources/mail/README.md": "contract of sources/mail",
      "sources/mail/2026-10-01T10-00.md": "record of sources/mail, day 2026-10-01",
      "sources/mail/updates.md": "record of sources/mail, day none",
      "topics/garden.md": "knowledge",
      "imported/README.md": "contract of imported",
      "imported/codex/README.md": "contract of imported/codex",
      "imported/codex/2024-01-01-notes.md": "record of imported/codex, day none",
      "DAILY/2026-11-02.md": "record of daily, day 2026-11-02"
    })
  })

  it("names each folder's producer", () => {
    expect(
      [...folders.values()].map((folder) => [folder.directory, folder.producer]).sort()
    ).toEqual([
      ["daily", { kind: "automation", automationId: "auto-daily" }],
      ["imported", { kind: "import" }],
      ["imported/codex", { kind: "import" }],
      ["sources/mail", { kind: "automation", automationId: "auto-mail" }]
    ])
  })
})

describe("imported notes", () => {
  it("are records by their path alone, with no README or with an archived one", () => {
    const kinds = (pages: ReadonlyArray<PageRecord>) => {
      const folders = recordFolders(pages)
      return ["imported/notes.md", "imported/codex/2024-01-01-notes.md"].map(
        (path) => pageKind(folders, path).kind
      )
    }
    expect([
      kinds([page("topics/garden.md")]),
      kinds([
        {
          ...page("imported/README.md"),
          resource: { ...page("imported/README.md").resource, state: "archived" }
        }
      ])
    ]).toEqual([
      ["record", "record"],
      ["record", "record"]
    ])
  })
})
