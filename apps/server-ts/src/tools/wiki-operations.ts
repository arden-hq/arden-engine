import { countOf } from "@arden-hq/std/count"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { writeIdentity } from "./wiki-identity.js"
import { formatWikiPage } from "../wiki/page.js"
import { WikiEmbeddingIndex } from "../embedding/wiki-index.js"
import { Wiki } from "../wiki/service.js"
import { boundedDiff } from "./bounded-diff.js"
import { STANDING_LIMIT_NOTE } from "../memory/core-memory.js"
import { activeRunPages, type PageRecord } from "../wiki/snapshot.js"
import { activePage, readablePage, loadSnapshot, pageNotFound, wikiFailure } from "./wiki-access.js"
import { changePages, keptPage } from "./wiki-page-writes.js"
import { pageData, writtenPageData } from "./wiki-render.js"
import { loadPageAges } from "../wiki/page-age.js"
import { makeWikiRetireTools } from "./wiki-retire.js"
import { makeWikiPageHistoryTools } from "./wiki-page-history.js"
import { MAX_PAGE_SOURCES, directoryReceipt, pageSource, requireObserved } from "./wiki-records.js"
import { searchPages } from "./wiki-search.js"
import { readChangeCall } from "../lib/memory-link.js"
import { WIKI_PAGE_BUDGET_CHARS } from "./wiki-schemas.js"
import {
  CreateDirectoryParametersSchema,
  LinksParametersSchema,
  ListChangesParametersSchema,
  MoveParametersSchema,
  PatchParametersSchema,
  SearchParametersSchema
} from "./wiki-operation-parameters.js"
import { directoryOutcome, linkData, patchedBody } from "./wiki-operation-results.js"

interface WikiOperationDeps {
  readonly wiki: Wiki["Service"]
  readonly runs: Pick<RunQueries["Service"], "get" | "cause">
  readonly embeddings: Pick<WikiEmbeddingIndex["Service"], "search">
  readonly sessions: Pick<SessionQueries["Service"], "loadHistoryHeader">
}

const makeWikiOperationTools = ({
  wiki,
  runs,
  embeddings,
  sessions
}: WikiOperationDeps): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "wiki_search",
    summary: "Searches memory.",
    discovery: "always_loaded",
    description:
      "Search Memory pages. Write what you are looking for in a few words; pages are found by their words and by their meaning, best match first, and the query does not have to appear as an exact phrase. Each result says how long ago the page last changed. Read a result before changing it.",
    parameters: Schema.toStandardSchemaV1(SearchParametersSchema),
    metadata: {
      effect: "none",
      background: true,
      display_name: "Search Wiki",
      kind: "tool",
      action: "read",
      approval_preview: "Search Memory pages.",
      source: "_wiki",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (input, ctx) => {
      const snapshot = await loadSnapshot(wiki, ctx.signal)
      const semantic = await Effect.runPromise(
        embeddings.search(snapshot, input.query).pipe(Effect.catchCause(() => Effect.succeed([]))),
        { signal: ctx.signal }
      )
      const matches = searchPages(
        activeRunPages(snapshot.pages),
        input.query,
        input.limit,
        semantic
      )
      const ages = await Effect.runPromise(loadPageAges(wiki, snapshot.head), {
        signal: ctx.signal
      })
      const changed = (record: PageRecord): string => {
        const ago = ages.ago(record.page.pageId)
        return ago === undefined ? "" : ` (changed ${ago})`
      }
      const source_refs = matches
        .slice(0, MAX_PAGE_SOURCES)
        .map(({ record }) => pageSource(record, "found"))
      const entries = matches.map(({ record, snippet: excerpt }) => ({
        ...pageData(record),
        page_id: record.page.pageId,
        version: record.resource.versionId,
        snippet: excerpt
      }))
      return {
        result:
          matches.length === 0
            ? "No matching Wiki pages."
            : `Wiki search results\n${matches
                .map(
                  ({ record, snippet: excerpt }) =>
                    `- ${record.resource.path} — ${record.page.title}${changed(record)}${excerpt === "" ? "" : ` — ${excerpt}`}`
                )
                .join("\n")}`,
        preview: `${countOf(matches.length, "Wiki match")}`,
        host: { source_refs },
        data: { source_refs, query: input.query, entries }
      }
    }
  }),
  defineServerTool({
    name: "wiki_list_changes",
    summary: "Looks at recent changes to memory.",
    discovery: { group: "wiki_upkeep" },
    description:
      "List bounded newest-first Memory changes since an inclusive timestamp, with each one's time, changed paths and provenance. Open one with wiki_read_change, a changed page and that time.",
    parameters: Schema.toStandardSchemaV1(ListChangesParametersSchema),
    metadata: {
      effect: "none",
      background: true,
      display_name: "List Wiki Changes",
      kind: "tool",
      action: "read",
      approval_preview: "List recent Memory changes.",
      source: "_wiki",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (input, ctx) => {
      const page = await Effect.runPromise(
        wiki.listChanges(input).pipe(Effect.mapError(wikiFailure)),
        {
          signal: ctx.signal
        }
      )
      const entries = page.entries.map((entry) => ({
        timestamp: entry.timestamp,
        actor: entry.actor,
        origin: entry.origin,
        reason: entry.reason,
        changes: entry.changes.map((change) => ({
          action: change.action,
          path: change.path,
          before_path: change.beforePath,
          after_path: change.afterPath
        }))
      }))
      const nextOffset = input.offset + entries.length
      const [newest] = entries
      const [changed] = newest?.changes ?? []
      const opened =
        newest === undefined || changed === undefined
          ? undefined
          : readChangeCall(changed.path, newest.timestamp)
      return {
        result:
          entries.length === 0
            ? "No Wiki changes in this time window."
            : `Wiki changes\n${entries
                .map(
                  (entry) =>
                    `- ${entry.timestamp} — ${entry.changes.map((change) => change.path).join(", ")} — ${entry.reason}`
                )
                .join(
                  "\n"
                )}${page.hasMore ? `\nMore changes exist; retry with offset=${nextOffset}.` : ""}${opened === undefined ? "" : `\nOpen a change's diff with a page it changed and its time, as in ${opened}.`}`,
        preview: `${countOf(entries.length, "Wiki change")}${page.hasMore ? " (capped)" : ""}`,
        data: {
          since: input.since,
          offset: input.offset,
          entries,
          has_more: page.hasMore,
          next_offset: page.hasMore ? nextOffset : null
        }
      }
    }
  }),
  ...makeWikiPageHistoryTools({ wiki, runs, sessions }),
  defineServerTool({
    name: "wiki_links",
    summary: "Lists one memory page's links and backlinks.",
    discovery: { group: "wiki_upkeep" },
    description:
      "List one Wiki page's outgoing links, with each target's path or unresolved status, and the pages that link to it. A merged path reads the page that replaced it.",
    parameters: Schema.toStandardSchemaV1(LinksParametersSchema),
    metadata: {
      effect: "none",
      background: true,
      display_name: "Wiki Links",
      kind: "tool",
      action: "read",
      approval_preview: "Read links for one Memory page.",
      source: "_wiki",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (input, ctx) => {
      const snapshot = await loadSnapshot(wiki, ctx.signal)
      const record = readablePage(snapshot, input.path)
      if (record === null) throw pageNotFound(snapshot, input.path)
      const report = await Effect.runPromise(
        wiki.links(record.page.pageId).pipe(Effect.mapError(wikiFailure)),
        { signal: ctx.signal }
      )
      const paths = new Map(
        snapshot.pages.map((page) => [page.page.pageId, page.resource.path] as const)
      )
      const outgoing = report.outgoing.slice(0, input.limit).map((link) => linkData(link, paths))
      const backlinks = report.backlinks.slice(0, input.limit).map((link) => linkData(link, paths))
      return {
        result: [
          `Wiki links for ${record.resource.path}`,
          `Outgoing (${outgoing.length} of ${report.outgoing.length}):`,
          ...outgoing.map(
            (link) =>
              `- ${link.target_path ?? link.target}${link.heading === null ? "" : `#${link.heading}`}${link.status === "unresolved" ? " (unresolved)" : ""}`
          ),
          `Backlinks (${backlinks.length} of ${report.backlinks.length}):`,
          ...backlinks.map((link) => `- ${link.source_path ?? link.source_page_id}`)
        ].join("\n"),
        preview: `${outgoing.length} outgoing, ${countOf(backlinks.length, "backlink")}`,
        data: {
          page: pageData(record),
          outgoing,
          backlinks,
          outgoing_total: report.outgoing.length,
          backlinks_total: report.backlinks.length,
          links_truncated:
            outgoing.length < report.outgoing.length || backlinks.length < report.backlinks.length
        }
      }
    }
  }),
  defineServerTool({
    name: "wiki_create_directory",
    summary: "Adds a folder to memory.",
    discovery: { group: "wiki_admin" },
    description: [
      "Create one managed Wiki directory with a complete README contract.",
      "The parent must already exist for nested paths. If <path>.md owns the name and is safe to move,",
      "it becomes <path>/README.md with the same page identity and history.",
      "Repeating the same contract changes nothing. Asks by default, except in Memory runs."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(CreateDirectoryParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Create Wiki Directory",
      kind: "tool",
      action: "write",
      default_approval: "ask",
      approval_preview: "Create a Memory folder.",
      source: "_wiki",
      scopes: ["memory_capture"],
      unattended_scope: "memory_capture",
      changes_state: true,
      concurrency_group: "wiki_write",
      destructive: false,
      target: "reported"
    },
    execute: async (input, ctx, effects) => {
      const identity = await writeIdentity(runs, { ...ctx.run, signal: ctx.signal })
      const created = await Effect.runPromise(
        wiki
          .createDirectory({
            path: input.path,
            body: input.body,
            authority: identity.authority,
            commit: {
              actor: identity.actor,
              origin: identity.origin,
              reason: `create Wiki directory ${input.path}`
            }
          })
          .pipe(Effect.mapError(wikiFailure)),
        { signal: ctx.signal }
      )
      if (created.changed) effects.applied()
      else effects.unchanged()
      ctx.run.observations.observe(created.page.pageId, created.page.version)
      const outcome = directoryOutcome(
        input.path,
        created.page.path,
        created.changed,
        created.adopted
      )
      return {
        ...outcome,
        data: {
          directory: input.path,
          page: writtenPageData(created.page),
          changed: created.changed,
          adopted: created.adopted
        },
        ...(created.changed ? { host: directoryReceipt(ctx, created.page) } : {})
      }
    }
  }),
  defineServerTool({
    name: "wiki_patch_page",
    summary: "Changes part of a memory page.",
    discovery: { group: "wiki_upkeep" },
    description:
      "Replace one exact text block in an active Wiki page body. The old text must match exactly once; no prior read is needed. " +
      `Aim for ${WIKI_PAGE_BUDGET_CHARS} characters. Condense repetition before splitting; ` +
      "create another page only for a distinct subject or useful reading scope, with a contextual link. " +
      `${STANDING_LIMIT_NOTE} Asks by default, except in Memory runs.`,
    parameters: Schema.toStandardSchemaV1(PatchParametersSchema),
    metadata: {
      display: [{ fact: "card", value: "page_patch" }],
      effect: "arden_db",
      display_name: "Patch Wiki Page",
      kind: "tool",
      action: "write",
      default_approval: "ask",
      approval_preview: "Edit part of a Memory page.",
      source: "_wiki",
      scopes: ["memory_capture"],
      unattended_scope: "memory_capture",
      changes_state: true,
      concurrency_group: "wiki_write",
      destructive: true,
      target: "reported"
    },
    approvalPrompt: async (input, ctx) => {
      const snapshot = await loadSnapshot(wiki, ctx.signal)
      const record = activePage(snapshot, input.path)
      if (record === null) throw pageNotFound(snapshot, input.path)
      const body = patchedBody(record, input)
      return {
        preview: `Update ${record.resource.path}`,
        presentation: {
          title: "Update this Memory page?",
          subject: record.resource.path,
          fields: [],
          approve_label: "Keep",
          reject_label: "Refuse"
        },
        ...(body === record.page.body
          ? {}
          : { diff: boundedDiff(record.resource.path, record.page.body, body) })
      }
    },
    execute: async (input, ctx, effects) => {
      const {
        records: [record],
        saved: [{ page }],
        changed,
        receipt
      } = await changePages({ wiki, runs }, ctx, effects, {
        input,
        paths: [input.path],
        save: async ({ head, records: [record], writer, run }) => {
          const body = patchedBody(record, input)
          if (body === record.page.body) return [keptPage(record)]
          const [updated] = await run(
            wiki.update({
              edits: [
                {
                  pageId: record.page.pageId,
                  content: formatWikiPage({ ...record.page, body }),
                  expectedVersion: record.resource.versionId
                }
              ],
              expectedHead: head,
              ...writer(`patch wiki page ${record.resource.path}`)
            })
          )
          return [{ page: updated, before: record.resource.versionId }]
        }
      })
      return changed
        ? {
            result: `Patched ${page.path}.`,
            preview: "Wiki page patched",
            data: { page: writtenPageData(page), changed: true },
            ...(receipt === undefined ? {} : { host: receipt })
          }
        : {
            result: `${record.resource.path} already has the requested body.`,
            preview: "Wiki page unchanged",
            data: { page: pageData(record), changed: false }
          }
    }
  }),
  ...makeWikiRetireTools({ wiki, runs }),
  defineServerTool({
    name: "wiki_move_page",
    summary: "Moves or renames a memory page.",
    discovery: { group: "wiki_admin" },
    description:
      "Move one active Wiki page and rewrite exact links to it while preserving identity and content. Read it first. Asks by default.",
    parameters: Schema.toStandardSchemaV1(MoveParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Move Wiki Page",
      kind: "tool",
      action: "write",
      default_approval: "ask",
      approval_preview: "Move one Memory page and update links to it.",
      source: "_wiki",
      changes_state: true,
      concurrency_group: "wiki_write",
      destructive: true,
      target: "reported"
    },
    execute: async (input, ctx, effects) => {
      let rewritten = { links: 0, pages: 0 }
      const {
        records: [record],
        saved: [{ page }],
        changed,
        receipt
      } = await changePages({ wiki, runs }, ctx, effects, {
        input,
        paths: [input.path],
        save: async ({ head, records: [record], writer, run }) => {
          if (record.resource.path === input.new_path) return [keptPage(record)]
          const expectedVersion = requireObserved(ctx.run, record)
          const renamed = await run(
            wiki.rename({
              pageId: record.page.pageId,
              newPath: input.new_path,
              newTitle: record.page.title,
              expectedVersion,
              expectedHead: head,
              ...writer(`move wiki page ${record.resource.path} to ${input.new_path}`)
            })
          )
          rewritten = { links: renamed.linkCount, pages: renamed.pageCount }
          return [{ page: await run(wiki.read(record.page.pageId)), before: expectedVersion }]
        }
      })
      if (!changed)
        return {
          result: `${record.resource.path} is already at the requested path.`,
          preview: "Wiki page unchanged",
          data: { page: pageData(record), changed: false }
        }
      return {
        result: `Moved ${record.resource.path} to ${page.path}.`,
        preview: "Wiki page moved",
        data: {
          page: writtenPageData(page),
          changed: true,
          rewritten_links: rewritten.links,
          rewritten_pages: rewritten.pages
        },
        ...(receipt === undefined ? {} : { host: receipt })
      }
    }
  })
]

export const wikiOperationTools = Effect.gen(function* () {
  return makeWikiOperationTools({
    wiki: yield* Wiki,
    runs: yield* RunQueries,
    embeddings: yield* WikiEmbeddingIndex,
    sessions: yield* SessionQueries
  })
})
