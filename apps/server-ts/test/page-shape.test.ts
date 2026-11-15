import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import type { UntrackedFile } from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { formatRedirectPage, formatWikiPage, parseWikiPage } from "../src/wiki/page.js"
import { FINDING_KINDS, memoryFindings, type FindingKind } from "../src/wiki/page-shape.js"
import type { PageRecord } from "../src/wiki/snapshot.js"

const HASH = "0".repeat(64)

const record = (path: string, content: string, pageId: string): PageRecord => ({
  resource: { resourceId: pageId, path, blobId: HASH, state: "active", versionId: HASH },
  page: Effect.runSync(parseWikiPage(content, pageId))
})

const page = (
  path: string,
  body: string,
  options: { readonly title?: string; readonly metadata?: Record<string, string> } = {}
): PageRecord =>
  record(
    path,
    formatWikiPage({
      pageId: `id:${path}`,
      title: options.title ?? path,
      aliases: [],
      lifecycle: "active",
      redirectTo: null,
      metadata: options.metadata ?? {},
      body
    }),
    `id:${path}`
  )

const redirect = (path: string, target: string): PageRecord =>
  record(
    path,
    formatRedirectPage({ pageId: `id:${path}`, title: path, redirectTo: target }),
    `id:${path}`
  )

const LONG = "The made-up project ships its first build once the review of the design is done."
const linked = (...paths: ReadonlyArray<string>) => paths.map((path) => `[[${path}]]`).join(" ")

const base = (...more: ReadonlyArray<PageRecord>): ReadonlyArray<PageRecord> => {
  const notes = more.map((extra) => extra.resource.path).filter((path) => path.startsWith("notes/"))
  return [
    page("README.md", `Entry. ${linked("notes/README.md", "daily/README.md")}`),
    page("notes/README.md", `Notes. ${linked(...notes)}`),
    page("daily/README.md", "## Purpose\n\nDays.\n", {
      metadata: { producer_automation_id: "automation-1" }
    }),
    ...more
  ]
}

const found = (
  pages: ReadonlyArray<PageRecord>,
  kind: FindingKind,
  untracked: ReadonlyArray<UntrackedFile> = []
) =>
  memoryFindings({ pages, untracked })
    .filter((finding) => finding.kind === kind)
    .map((finding) => finding.paths)

const bytes = (text: string) => new TextEncoder().encode(text)

describe("memoryFindings", () => {
  it("finds nothing in a tidy Memory", () => {
    expect(memoryFindings({ pages: base(page("notes/a.md", "A note.")), untracked: [] })).toEqual(
      []
    )
  })

  it("names the knowledge pages that share a long sentence, once per sentence", () => {
    const pages = base(
      page("notes/a.md", `${LONG} Short and shared.`),
      page("notes/b.md", `Intro.\n\n- ${LONG}\n- Short and shared.`),
      page("notes/c.md", `${LONG}\n\n${LONG}`),
      page("daily/2026-11-01.md", LONG)
    )
    expect(found(pages, "duplicate_sentence")).toEqual([["notes/a.md", "notes/b.md", "notes/c.md"]])
    expect(found(base(page("notes/a.md", `${LONG}\n\n${LONG}`)), "duplicate_sentence")).toEqual([])
  })

  it("names a knowledge page no other page links to", () => {
    const pages = [
      ...base(page("notes/a.md", "Linked.")),
      page("notes/lonely.md", `Only itself. ${linked("notes/lonely.md")}`),
      page("daily/2026-11-01.md", "A record no page links to.")
    ]
    expect(found(pages, "orphan")).toEqual([["notes/lonely.md"]])
  })

  it("names a knowledge page with more than one dated status line", () => {
    const pages = base(
      page("notes/two.md", "- **Status:** waiting, Oct 3\n- Status on 2026-10-09: done"),
      page("notes/one.md", "- **Status:** waiting, Oct 3\n- Status: done"),
      page("daily/2026-11-01.md", "Status: Oct 3.\n\nStatus: Oct 4.")
    )
    expect(found(pages, "two_status")).toEqual([["notes/two.md"]])
  })

  it("names a knowledge page with a section headed as a log", () => {
    const pages = base(
      page("notes/log.md", "Now.\n\n## Timeline\n\n- Oct 3: started\n"),
      page("notes/plain.md", "Now.\n\n## Related\n\nMore.\n"),
      page("daily/2026-11-01.md", "## Updates\n\nA record.\n")
    )
    expect(found(pages, "log_section")).toEqual([["notes/log.md"]])
  })

  it("names a page over the limit its one owner sets", () => {
    const at = (path: string, chars: number) => page(path, "x".repeat(chars))
    expect(found([...base(), at("me.md", 9_001)], "over_limit")).toEqual([["me.md"]])
    expect(found([...base(), at("me.md", 9_000)], "over_limit")).toEqual([])
  })

  it("names files in the folder that carry the id of a page", () => {
    const copy = formatWikiPage({
      pageId: "id:notes/a.md",
      title: "A copy",
      aliases: [],
      lifecycle: "active",
      redirectTo: null,
      metadata: {},
      body: "A copy."
    })
    const pages = base(page("notes/a.md", "A note."))
    expect(
      found(pages, "duplicate_id", [
        { kind: "read", path: "notes/a copy.md", content: bytes(copy) }
      ])
    ).toEqual([["notes/a copy.md", "notes/a.md"]])
  })

  it("names a redirect that does not end at an active page", () => {
    const pages = base(
      page("notes/a.md", "A note."),
      redirect("notes/old.md", "id:notes/a.md"),
      redirect("notes/gone.md", "id:notes/missing.md")
    )
    expect(found(pages, "broken_redirect")).toEqual([["notes/gone.md"]])
  })

  it("names each folder that holds pages but no README", () => {
    const pages = [
      ...base(),
      page("loose/x.md", `X. ${linked("notes/README.md")}`),
      page("notes/deep/y.md", "Y.")
    ]
    expect(found(pages, "no_readme")).toEqual([["loose"], ["notes/deep"]])
  })

  it("names a page with no text but headings", () => {
    const pages = base(
      page("notes/empty.md", "# Heading\n\n## Another\n"),
      page("notes/a.md", "A.")
    )
    expect(found(pages, "empty_page")).toEqual([["notes/empty.md"]])
  })

  it("names a page with a link that opens no page", () => {
    const pages = base(page("notes/a.md", `See ${linked("notes/nowhere.md")}.`))
    expect(found(pages, "broken_link")).toEqual([["notes/a.md"]])
  })

  it("names active pages that share a title", () => {
    const pages = base(
      page("notes/a.md", "A.", { title: "Plans" }),
      page("notes/b.md", "B.", { title: " plans" }),
      redirect("notes/old.md", "id:notes/a.md")
    )
    expect(found(pages, "shared_title")).toEqual([["notes/a.md", "notes/b.md"]])
  })

  it("names every other file in the folder that is not a Memory page", () => {
    const untracked: ReadonlyArray<UntrackedFile> = [
      { kind: "listed", path: "notes/list.txt" },
      { kind: "read", path: "notes/bad.md", content: bytes("no frontmatter") },
      { kind: "unreadable", path: "notes/locked.md", reason: "made-up reason" }
    ]
    expect(found(base(), "stray_file", untracked)).toEqual([
      ["notes/bad.md"],
      ["notes/list.txt"],
      ["notes/locked.md"]
    ])
  })

  it("carries paths only, in the order of its kinds", () => {
    const findings = memoryFindings({
      pages: base(page("notes/a.md", `${LONG} ${linked("nowhere.md")}`), page("loose/b.md", "")),
      untracked: []
    })
    expect(findings.map((finding) => Object.keys(finding).sort())).toEqual(
      findings.map(() => ["kind", "paths"])
    )
    const order = findings.map((finding) => FINDING_KINDS.indexOf(finding.kind))
    expect(order).toEqual([...order].sort((left, right) => left - right))
  })
})

describe("one owner", () => {
  const root = join(import.meta.dirname, "../src")
  const files = (directory: string): ReadonlyArray<string> =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return files(path)
      return entry.name.endsWith(".ts") ? [relative(root, path)] : []
    })
  const offenders = (pattern: RegExp) =>
    files(root).filter(
      (file) =>
        file !== "wiki/page-shape.ts" && pattern.test(readFileSync(join(root, file), "utf8"))
    )

  it("only page-shape.ts computes the shape facts of Memory pages", () => {
    expect({
      kinds: offenders(new RegExp(`["'](${FINDING_KINDS.join("|")})["']`, "u")),
      logHeadings: offenders(/timeline\|history/iu),
      statusLines: offenders(/status\|state/iu),
      findings: offenders(/\bmemoryFindings\b/u)
    }).toEqual({ kinds: [], logHeadings: [], statusLines: [], findings: [] })
  })
})
