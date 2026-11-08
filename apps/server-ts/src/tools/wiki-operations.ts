import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import { IsoDateTimeStringSchema } from "@arden-hq/protocol/effect/common"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { writeIdentity } from "./wiki-identity.js"
import { formatWikiPage } from "../wiki/page.js"
import { Wiki } from "../wiki/service.js"
import { boundedDiff } from "./bounded-diff.js"
import type { PageRecord } from "../wiki/snapshot.js"
import type { ServerRunContext } from "./run-context.js"
import {
  MAX_WIKI_CONTENT_CHARS,
  WIKI_PAGE_BUDGET_CHARS,
  WikiPathSchema,
  activePage,
  readablePage,
  activePages,
  captureReplayOrigin,
  loadSnapshot,
  pageData,
  pageNotFound,
  wikiFailure,
  writtenPageData
} from "./wiki.js"
import { recordApplied } from "../execution/tool-effect.js"
import { mergeArchivedPage } from "./wiki-merge.js"
import {
  MAX_PAGE_SOURCES,
  directoryReceipt,
  pageReceipt,
  pageSource,
  requireWithinCoreBudget
} from "./wiki-records.js"
import { searchPages } from "./wiki-search.js"

const MAX_HISTORY_ENTRIES = 100
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
      description: "Text to find in active Wiki page paths, titles, aliases, or bodies."
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

const HistoryParametersSchema = Schema.Struct({
  path: ActiveWikiPathSchema,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_HISTORY_ENTRIES }))
    .annotate({
      description: `Maximum newest-first revisions to return, from 1 to ${MAX_HISTORY_ENTRIES}. Defaults to 20.`
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(20)))
})

const RestoreParametersSchema = Schema.Struct({
  path: ActiveWikiPathSchema,
  revision_ref: Schema.NonEmptyString.check(Schema.isMaxLength(512)).annotate({
    description: "Exact reachable revision_ref returned by wiki_page_history."
  })
})

const LinksParametersSchema = Schema.Struct({
  path: ActiveWikiPathSchema,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LINKS }))
    .annotate({
      description: `Maximum outgoing links and backlinks to return, from 1 to ${MAX_LINKS}. Defaults to 100.`
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

const ArchiveParametersSchema = Schema.Struct({
  path: ActiveWikiPathSchema,
  merged_into: Schema.NullOr(ActiveWikiPathSchema).annotate({
    description:
      "The active page that now holds this page's content, or null when nothing replaces it. With a page, the archived path redirects there, so links to it, in the Wiki or elsewhere, keep working."
  })
})

const MoveParametersSchema = Schema.Struct({
  path: ActiveWikiPathSchema,
  new_path: Schema.NonEmptyString.check(Schema.isMinLength(4), Schema.isMaxLength(4_096)).annotate({
    description:
      "New relative POSIX .md path. Page identity, title, aliases, metadata, and body stay unchanged."
  })
})

const requireObserved = (ctx: ServerRunContext, record: PageRecord): string => {
  const observed = ctx.observations.observed(record.page.pageId)
  if (observed !== undefined) return observed
  throw new ToolExecutionError(`Read ${record.resource.path} before changing it, then retry.`, {
    preview: "Read required",
    retryable: false
  })
}

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
  requireWithinCoreBudget({ path: record.resource.path, pageId: record.page.pageId, body })
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

const makeWikiOperationTools = ({
  wiki,
  runs
}: {
  readonly wiki: Wiki["Service"]
  readonly runs: Pick<RunQueries["Service"], "get" | "cause">
}): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "wiki_search",
    description:
      "Search active Wiki page paths, titles, aliases, and Markdown bodies. Read an exact result before changing it.",
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
      const matches = searchPages(
        activePages(await loadSnapshot(wiki, ctx.signal)),
        input.query,
        input.limit
      )
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
                    `- ${record.resource.path} — ${record.page.title}${excerpt === "" ? "" : ` — ${excerpt}`}`
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
      "List bounded newest-first Wiki commits since an inclusive timestamp, with each revision, changed paths and provenance. Open one with wiki_read_change.",
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
        revision: entry.revision,
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
      return {
        result:
          entries.length === 0
            ? "No Wiki changes in this time window."
            : `Wiki changes\n${entries
                .map(
                  (entry) =>
                    `- ${entry.timestamp} — ${entry.revision} — ${entry.changes.map((change) => change.path).join(", ")} — ${entry.reason}`
                )
                .join(
                  "\n"
                )}${page.hasMore ? `\nMore changes exist; retry with offset=${nextOffset}.` : ""}\nOpen a change's diff with wiki_read_change and its revision, as in wiki_read_change(revision=${JSON.stringify(entries[0]?.revision ?? "")}).`,
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
  defineServerTool({
    name: "wiki_page_history",
    description:
      "List newest-first revisions of one active Wiki page by exact path. Returned revision_ref values can be passed to wiki_restore_page.",
    parameters: Schema.toStandardSchemaV1(HistoryParametersSchema),
    metadata: {
      effect: "none",
      background: true,
      display_name: "Wiki Page History",
      kind: "tool",
      action: "read",
      approval_preview: "Read one Memory page's history.",
      source: "_wiki",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (input, ctx) => {
      const snapshot = await loadSnapshot(wiki, ctx.signal)
      const record = readablePage(snapshot, input.path)
      if (record === null) throw pageNotFound(snapshot, input.path)
      const history = await Effect.runPromise(
        wiki.history(record.page.pageId, { limit: input.limit }).pipe(Effect.mapError(wikiFailure)),
        { signal: ctx.signal }
      )
      const entries = history.commits.flatMap((commit) => {
        const change = commit.changes.find(
          (candidate) => (candidate.after ?? candidate.before)?.resourceId === record.page.pageId
        )
        if (change === undefined) return []
        return [
          {
            revision_ref: commit.commitId,
            timestamp: commit.timestamp,
            actor: commit.actor,
            origin: commit.origin,
            reason: commit.reason,
            action: change.action,
            path: (change.after ?? change.before)?.path ?? input.path,
            restorable: change.after?.state === "active"
          }
        ]
      })
      return {
        result:
          entries.length === 0
            ? `No revisions found for ${input.path}.`
            : `Wiki history for ${input.path}\n${entries
                .map(
                  (entry) =>
                    `- ${entry.timestamp} — ${entry.revision_ref} — ${entry.action} — ${entry.reason}`
                )
                .join("\n")}`,
        preview: `${countOf(entries.length, "Wiki revision")}`,
        host: { source_refs: [pageSource(record, "read")] },
        data: { source_refs: [pageSource(record, "read")], path: record.resource.path, entries }
      }
    }
  }),
  defineServerTool({
    name: "wiki_restore_page",
    description:
      "Restore one active Wiki page exactly from a reachable revision while preserving its current path. Read the current page first. Asks by default.",
    parameters: Schema.toStandardSchemaV1(RestoreParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Restore Wiki Page",
      kind: "tool",
      action: "write",
      default_approval: "ask",
      approval_preview: "Restore one Memory page to an earlier version.",
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
      const identity = await writeIdentity(runs, { ...ctx.run, signal: ctx.signal })
      const expectedVersion = requireObserved(ctx.run, record)
      const restored = await Effect.runPromise(
        wiki
          .restoreRevision({
            pageId: record.page.pageId,
            commitId: input.revision_ref,
            expectedVersion,
            expectedHead: snapshot.head,
            authority: identity.authority,
            commit: {
              actor: identity.actor,
              origin: identity.origin,
              reason: `restore wiki page ${record.resource.path} from ${input.revision_ref}`
            }
          })
          .pipe(Effect.mapError(wikiFailure)),
        { signal: ctx.signal }
      )
      const changed = restored.version !== expectedVersion
      if (changed) effects.applied()
      else effects.unchanged()
      ctx.run.observations.observe(restored.pageId, restored.version)
      return {
        result: changed
          ? `Restored ${restored.path} from revision ${input.revision_ref}.`
          : `${restored.path} already matches revision ${input.revision_ref}.`,
        preview: changed ? "Wiki page restored" : "Wiki page unchanged",
        data: {
          page: writtenPageData(restored),
          restored_from_revision: input.revision_ref,
          changed
        },
        ...(changed
          ? { host: pageReceipt({ ctx, page: restored, beforeVersion: expectedVersion }) }
          : {})
      }
    }
  }),
  defineServerTool({
    name: "wiki_links",
    description: "Read exact outgoing links and backlinks for one active Wiki page.",
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
          `Outgoing: ${outgoing.length}/${report.outgoing.length}`,
          `Backlinks: ${backlinks.length}/${report.backlinks.length}`
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
      "Open one managed Wiki directory with a complete README contract.",
      "The parent must already exist for nested paths. If <path>.md owns the name and is safe to move,",
      "it becomes <path>/README.md with the same page identity and history."
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
              origin: captureReplayOrigin(
                identity.origin,
                "create-directory",
                input.path,
                input.body
              ),
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
      "Replace one exact text block in an active Wiki page body. The old text must match exactly once. " +
      `Aim for ${WIKI_PAGE_BUDGET_CHARS} characters. Condense repetition before splitting; ` +
      "create another page only for a distinct subject or useful reading scope, with a contextual link.",
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
      const updated = await recordApplied(
        effects,
        Effect.runPromise(
          wiki
            .update({
              pageId: record.page.pageId,
              content: formatWikiPage({ ...record.page, body }),
              expectedVersion: record.resource.versionId,
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
  defineServerTool({
    name: "wiki_archive_page",
    description:
      "Recoverably archive one active Wiki page. Read it first; revision history is retained. Say in merged_into which page now holds its content, or null when none does. Asks by default.",
    parameters: Schema.toStandardSchemaV1(ArchiveParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Archive Wiki Page",
      kind: "tool",
      action: "write",
      default_approval: "ask",
      approval_preview: "Archive one Memory page.",
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
      const identity = await writeIdentity(runs, { ...ctx.run, signal: ctx.signal })
      const expectedVersion = requireObserved(ctx.run, record)
      if (input.merged_into !== null)
        return mergeArchivedPage({
          wiki,
          snapshot,
          head: snapshot.head,
          record,
          target: input.merged_into,
          ctx,
          effects,
          identity,
          expectedVersion
        })
      const archived = await recordApplied(
        effects,
        Effect.runPromise(
          wiki
            .archive({
              pageId: record.page.pageId,
              expectedVersion,
              expectedHead: snapshot.head,
              authority: identity.authority,
              commit: {
                actor: identity.actor,
                origin: identity.origin,
                reason: `archive wiki page ${record.resource.path}`
              }
            })
            .pipe(Effect.mapError(wikiFailure)),
          { signal: ctx.signal }
        )
      )
      ctx.run.observations.observe(archived.pageId, archived.version)
      return {
        result: `Archived ${archived.path}.`,
        preview: "Wiki page archived",
        data: { page: archived, changed: true },
        host: pageReceipt({
          ctx,
          page: { ...archived, title: record.page.title },
          beforeVersion: expectedVersion
        })
      }
    }
  }),
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
      const expectedVersion = requireObserved(ctx.run, record)
      const requested = await Effect.runPromise(
        wiki
          .requestRename({
            pageId: record.page.pageId,
            newPath: input.new_path,
            newTitle: record.page.title,
            expectedVersion,
            expectedHead: snapshot.head,
            authority: identity.authority
          })
          .pipe(Effect.mapError(wikiFailure)),
        { signal: ctx.signal }
      )
      const accepted = await Effect.runPromise(
        wiki
          .acceptRename({
            approvalId: requested.approvalId,
            authority: identity.authority,
            commit: {
              actor: identity.actor,
              origin: identity.origin,
              reason: `move wiki page ${record.resource.path} to ${input.new_path}`
            }
          })
          .pipe(Effect.mapError(wikiFailure)),
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
  return makeWikiOperationTools({ wiki: yield* Wiki, runs: yield* RunQueries })
})
