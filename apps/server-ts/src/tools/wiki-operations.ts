import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import { IsoDateTimeStringSchema } from "@arden-hq/protocol/effect/common"
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
import {
  MAX_WIKI_CONTENT_CHARS,
  WIKI_PAGE_BUDGET_CHARS,
  WikiPathSchema,
  activePage,
  readablePage,
  loadSnapshot,
  pageData,
  pageNotFound,
  wikiFailure,
  writtenPageData
} from "./wiki.js"
import { recordApplied } from "../execution/tool-effect.js"
import { loadPageAges } from "../wiki/page-age.js"
import { makeWikiRetireTools } from "./wiki-retire.js"
import { MergedWikiPathSchema, makeWikiPageHistoryTools } from "./wiki-page-history.js"
import {
  MAX_PAGE_SOURCES,
  directoryReceipt,
  pageReceipt,
  pageSource,
  requireObserved
} from "./wiki-records.js"
import { searchPages } from "./wiki-search.js"
import { readChangeCall } from "../lib/memory-link.js"

const MAX_LINKS = 500
const MAX_SEARCH_RESULTS = 20
const MAX_CHANGE_OFFSET = 10_000
const MAX_CHANGE_ENTRIES = 200

const ActiveWikiPathSchema = WikiPathSchema.annotate({
  description: "Exact relative POSIX .md path of an active page returned by Wiki search or listing."
})

const SearchParametersSchema = Schema.Struct({
  query: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512)).pipe(
    Schema.annotateEncoded({
      description: "What to look for: a few words, a name, a path, or an exact phrase."
    })
  ),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SEARCH_RESULTS }))
    .annotate({
      description: `Maximum matches to return, from 1 to ${MAX_SEARCH_RESULTS}. Defaults to 8.`
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(8)))
})

const ListChangesSinceSchema = Schema.String.pipe(
  Schema.annotateEncoded({
    description: "Inclusive ISO-8601 timestamp with an explicit zone."
  }),
  Schema.decodeTo(IsoDateTimeStringSchema)
)

const ListChangesParametersSchema = Schema.Struct({
  since: ListChangesSinceSchema,
  offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_CHANGE_OFFSET }))
    .annotate({ description: "Zero-based commit offset. Defaults to 0." })
    .pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CHANGE_ENTRIES }))
    .annotate({
      description: `Maximum commits to return, from 1 to ${MAX_CHANGE_ENTRIES}. Defaults to 100.`
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(100)))
})

const CreateDirectoryParametersSchema = Schema.Struct({
  path: Schema.NonEmptyString.check(Schema.isMaxLength(4_096)).annotate({
    description:
      "Relative POSIX directory path without a trailing slash, such as 'people' or 'projects/research'."
  }),
  body: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS)).annotate({
    description:
      "Complete Markdown contract containing exact ## Purpose, ## Producers, ## Consumers, ## Boundaries, and ## Retention headings with nonempty sections. Add ## Records to describe filenames, dates/timezone, source pointers and lookup conventions."
  })
})

const LinksParametersSchema = Schema.Struct({
  path: MergedWikiPathSchema,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LINKS }))
    .annotate({
      description: `Maximum links to return in each list (outgoing and backlinks), from 1 to ${MAX_LINKS}. Defaults to 100.`
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(100)))
})

const PatchParametersSchema = Schema.Struct({
  path: ActiveWikiPathSchema,
  old_text: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS)).annotate({
    description: "Exact current body text to replace. It must occur exactly once."
  }),
  new_text: Schema.String.check(Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS)).annotate({
    description: "Literal replacement text. Empty removes the matched text."
  })
})

const MoveParametersSchema = Schema.Struct({
  path: ActiveWikiPathSchema,
  new_path: Schema.NonEmptyString.check(Schema.isMinLength(4), Schema.isMaxLength(4_096)).annotate({
    description:
      "New relative POSIX .md path. Page identity, title, aliases, metadata, and body stay unchanged."
  })
})

const exactOccurrences = (body: string, text: string): number => body.split(text).length - 1

const preparePatch = async (
  wiki: Wiki["Service"],
  input: { readonly path: string; readonly old_text: string; readonly new_text: string },
  signal: AbortSignal
): Promise<{ readonly head: string; readonly record: PageRecord; readonly body: string }> => {
  const snapshot = await loadSnapshot(wiki, signal)
  const record = activePage(snapshot, input.path)
  if (record === null || snapshot.head === null) throw pageNotFound(snapshot, input.path)
  const occurrences = exactOccurrences(record.page.body, input.old_text)
  if (occurrences !== 1) {
    throw new ToolExecutionError(
      occurrences === 0
        ? "old_text was not found in the current Wiki page body."
        : `old_text matches ${occurrences} places in the current Wiki page body.`,
      { preview: "Patch not applied", retryable: false }
    )
  }
  const body = record.page.body.replace(input.old_text, () => input.new_text)
  if (body.trim().length === 0) {
    throw new ToolExecutionError(
      "A Wiki page must retain content. Archive it to remove the page.",
      {
        preview: "Patch not applied",
        retryable: false
      }
    )
  }
  return { head: snapshot.head, record, body }
}

const directoryOutcome = (
  directory: string,
  pagePath: string,
  changed: boolean,
  adopted: boolean
): { readonly result: string; readonly preview: string } => {
  if (!changed) {
    return {
      result: `Wiki directory ${directory}/ already has the requested contract.`,
      preview: "Wiki directory unchanged"
    }
  }
  if (adopted) {
    return {
      result: `Opened ${directory}.md as ${pagePath} with the same page identity and history.`,
      preview: "Wiki directory opened"
    }
  }
  return {
    result: `Created Wiki directory ${directory}/ with contract ${pagePath}.`,
    preview: "Wiki directory created"
  }
}

const linkData = (
  link: {
    readonly sourcePageId: string
    readonly target: string
    readonly alias: string | null
    readonly heading: string | null
    readonly status: "resolved" | "unresolved"
    readonly targetPageId: string | null
  },
  paths: ReadonlyMap<string, string>
) => ({
  source_page_id: link.sourcePageId,
  source_path: paths.get(link.sourcePageId) ?? null,
  target: link.target,
  alias: link.alias,
  heading: link.heading,
  status: link.status,
  target_page_id: link.targetPageId,
  target_path: link.targetPageId === null ? null : (paths.get(link.targetPageId) ?? null)
})

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
      // Search by meaning is extra: when it is off or fails, words and phrases still find pages.
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
    description:
      "Replace one exact text block in an active Wiki page body. The old text must match exactly once; no prior read is needed. " +
      `Aim for ${WIKI_PAGE_BUDGET_CHARS} characters. Condense repetition before splitting; ` +
      "create another page only for a distinct subject or useful reading scope, with a contextual link. " +
      `${STANDING_LIMIT_NOTE} Asks by default, except in Memory runs.`,
    parameters: Schema.toStandardSchemaV1(PatchParametersSchema),
    metadata: {
      display: { card: "page_patch" },
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
      const { record, body } = await preparePatch(wiki, input, ctx.signal)
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
      const { head, record, body } = await preparePatch(wiki, input, ctx.signal)
      if (body === record.page.body) {
        effects.unchanged()
        return {
          result: `${record.resource.path} already has the requested body.`,
          preview: "Wiki page unchanged",
          data: { page: pageData(record), changed: false }
        }
      }
      const identity = await writeIdentity(runs, { ...ctx.run, signal: ctx.signal })
      const [updated] = await recordApplied(
        effects,
        Effect.runPromise(
          wiki
            .update({
              edits: [
                {
                  pageId: record.page.pageId,
                  content: formatWikiPage({ ...record.page, body }),
                  expectedVersion: record.resource.versionId
                }
              ],
              expectedHead: head,
              authority: identity.authority,
              commit: {
                actor: identity.actor,
                origin: identity.origin,
                reason: `patch wiki page ${record.resource.path}`
              }
            })
            .pipe(Effect.mapError(wikiFailure)),
          { signal: ctx.signal }
        )
      )
      ctx.run.observations.observe(updated.pageId, updated.version)
      return {
        result: `Patched ${updated.path}.`,
        preview: "Wiki page patched",
        data: { page: writtenPageData(updated), changed: true },
        host: pageReceipt({ ctx, page: updated, beforeVersion: record.resource.versionId })
      }
    }
  }),
  ...makeWikiRetireTools({ wiki, runs }),
  defineServerTool({
    name: "wiki_move_page",
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
      const snapshot = await loadSnapshot(wiki, ctx.signal)
      const record = activePage(snapshot, input.path)
      if (record === null || snapshot.head === null) throw pageNotFound(snapshot, input.path)
      if (record.resource.path === input.new_path) {
        effects.unchanged()
        ctx.run.observations.observe(record.page.pageId, record.resource.versionId)
        return {
          result: `${record.resource.path} is already at the requested path.`,
          preview: "Wiki page unchanged",
          data: { page: pageData(record), changed: false }
        }
      }
      const identity = await writeIdentity(runs, { ...ctx.run, signal: ctx.signal })
      const commit = {
        actor: identity.actor,
        origin: identity.origin,
        reason: `move wiki page ${record.resource.path} to ${input.new_path}`
      }
      const expectedVersion = requireObserved(ctx.run, record)
      const requested = await Effect.runPromise(
        wiki
          .requestRename({
            pageId: record.page.pageId,
            newPath: input.new_path,
            newTitle: record.page.title,
            expectedVersion,
            expectedHead: snapshot.head,
            authority: identity.authority,
            commit
          })
          .pipe(Effect.mapError(wikiFailure)),
        { signal: ctx.signal }
      )
      const accepted = await Effect.runPromise(
        wiki.acceptRename({ approvalId: requested.approvalId }).pipe(Effect.mapError(wikiFailure)),
        { signal: ctx.signal }
      )
      if (accepted.status !== "accepted") {
        throw new ToolExecutionError(
          accepted.resolution ??
            "The Wiki changed before the move could be committed. Read the page and retry.",
          { preview: "Wiki move not applied", retryable: true }
        )
      }
      effects.applied()
      const moved = await Effect.runPromise(
        wiki.read(record.page.pageId).pipe(Effect.mapError(wikiFailure)),
        { signal: ctx.signal }
      )
      ctx.run.observations.observe(moved.pageId, moved.version)
      return {
        result: `Moved ${record.resource.path} to ${moved.path}.`,
        preview: "Wiki page moved",
        data: {
          page: writtenPageData(moved),
          changed: true,
          rewritten_links: accepted.linkCount,
          rewritten_pages: accepted.pageCount
        },
        host: pageReceipt({ ctx, page: moved, beforeVersion: expectedVersion })
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
