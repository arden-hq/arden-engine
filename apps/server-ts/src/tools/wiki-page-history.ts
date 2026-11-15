import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"
import { Effect, Schema } from "effect"

import { RunQueries } from "../persistence/runs/queries.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import type { PageRecord, Snapshot } from "../wiki/snapshot.js"
import type { Wiki } from "../wiki/service.js"
import { boundedDiff } from "./bounded-diff.js"
import { defineServerTool, type ServerTool } from "./define.js"
import type { ServerRunContext } from "./run-context.js"
import {
  WikiPathSchema,
  loadSnapshot,
  pageNotFound,
  readablePage,
  wikiFailure,
  writtenPageData
} from "./wiki.js"
import { changeFailure, ChangeTimeSchema } from "./wiki-change.js"
import { writeIdentity, type WikiWriteIdentity } from "./wiki-identity.js"
import type { WikiCommitIdentity } from "../wiki/commit.js"
import { lineOriginOutput } from "./wiki-line-origin.js"
import { pageReceipt, pageSource, requireObserved } from "./wiki-records.js"

const MAX_HISTORY_ENTRIES = 100
const MAX_LINE_CHARS = 4_096

export const MergedWikiPathSchema = WikiPathSchema.annotate({
  description:
    "Exact relative POSIX .md path of an active page, or of a page that was merged into another."
})

const HistoryParametersSchema = Schema.Struct({
  path: MergedWikiPathSchema,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_HISTORY_ENTRIES }))
    .annotate({
      description: `Maximum newest-first revisions to return, from 1 to ${MAX_HISTORY_ENTRIES}. Defaults to 20.`
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(20))),
  line: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_LINE_CHARS))
    .pipe(
      Schema.annotateEncoded({
        description:
          "Text from one line of the page. Instead of the list, returns the change that added that line: who wrote it, when, and in which chat."
      })
    )
    .pipe(Schema.optionalKey)
})

const RestoreParametersSchema = Schema.Struct({
  path: MergedWikiPathSchema,
  at: ChangeTimeSchema.annotate({
    description:
      "Time of the version to bring back, as wiki_page_history lists it. The page returns to how it was at that time."
  })
})

/**
 * The page stored at exactly this path, merged pages included. History and restore work on the
 * page itself, where reading follows a merged path to the page that replaced it.
 */
const pageStoredAt = (snapshot: Snapshot, path: string): PageRecord | null =>
  snapshot.pages.find((record) => record.resource.path === path) ?? readablePage(snapshot, path)

/**
 * The page a restore names, the version of it the run has seen, and the saved change to bring
 * back. A merged page has no body to read; its stored version is the one to restore over.
 */
const prepareRestore = async (
  wiki: Wiki["Service"],
  input: { readonly path: string; readonly at: string },
  ctx: ToolContext<ServerRunContext>
) => {
  const snapshot = await loadSnapshot(wiki, ctx.signal)
  const record = pageStoredAt(snapshot, input.path)
  if (record === null || snapshot.head === null) throw pageNotFound(snapshot, input.path)
  const expectedVersion =
    record.page.lifecycle === "redirect"
      ? record.resource.versionId
      : requireObserved(ctx.run, record)
  const version = await Effect.runPromise(
    wiki
      .changeAt({ path: record.resource.path, pageId: record.page.pageId, at: input.at })
      .pipe(Effect.mapError((error) => changeFailure(error, record.resource.path))),
    { signal: ctx.signal }
  )
  return { head: snapshot.head, record, expectedVersion, version }
}

const restoreCommit = (
  identity: Pick<WikiWriteIdentity, "actor" | "origin">,
  path: string,
  savedAt: string
): WikiCommitIdentity => ({
  actor: identity.actor,
  origin: identity.origin,
  reason: `restore wiki page ${path} to its version saved ${savedAt}`
})

/** A page's saved history, where one of its lines came from, and bringing back an earlier version. */
export const makeWikiPageHistoryTools = ({
  wiki,
  runs,
  sessions
}: {
  readonly wiki: Wiki["Service"]
  readonly runs: Pick<RunQueries["Service"], "get" | "cause">
  readonly sessions: Pick<SessionQueries["Service"], "loadHistoryHeader">
}): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "wiki_page_history",
    description:
      "List newest-first saved changes of one Wiki page by exact path, including a page that was merged into another. Pass a listed time as `at` to wiki_read_change to see that change, or to wiki_restore_page to bring that version back.",
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
      const record = pageStoredAt(snapshot, input.path)
      if (record === null) throw pageNotFound(snapshot, input.path)
      if (input.line !== undefined)
        return lineOriginOutput({ wiki, sessions }, record, input.line, ctx.signal)
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
      // The listing names the current version, so a restore can follow it. A version the run read
      // earlier is kept: a change it has not seen still refuses the restore.
      if (ctx.run.observations.observed(record.page.pageId) === undefined)
        ctx.run.observations.observe(record.page.pageId, record.resource.versionId)
      return {
        result:
          entries.length === 0
            ? `No revisions found for ${input.path}.`
            : `Wiki history for ${input.path}\n${entries
                .map(
                  (entry) =>
                    `- ${entry.timestamp} — ${entry.action} — ${entry.reason}${entry.restorable ? "" : " (not restorable)"}`
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
      "Restore one Wiki page to how it was at a time wiki_page_history lists, while preserving its current path. Read the page or list its history first. A page that was merged into another comes back as its own page; give its old path. Asks by default.",
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
    approvalPrompt: async (input, ctx) => {
      const { head, record, expectedVersion, version } = await prepareRestore(wiki, input, ctx)
      if (expectedVersion !== record.resource.versionId)
        throw new ToolExecutionError(
          `${record.resource.path} changed after this run read it. Read it again, then retry.`,
          { preview: "Page changed", retryable: false }
        )
      const identity = await writeIdentity(runs, { ...ctx.run, signal: ctx.signal })
      const content = await Effect.runPromise(
        wiki
          .contentToRestore({
            pageId: record.page.pageId,
            commitId: version.commitId,
            head,
            authority: identity.authority,
            commit: restoreCommit(identity, record.resource.path, version.timestamp)
          })
          .pipe(Effect.mapError(wikiFailure)),
        { signal: ctx.signal }
      )
      return {
        preview: `Restore ${record.resource.path}`,
        presentation: {
          title: "Bring back this version of the Memory page?",
          subject: record.resource.path,
          fields: [],
          approve_label: "Restore",
          reject_label: "Refuse"
        },
        ...(content === record.page.content
          ? {}
          : { diff: boundedDiff(record.resource.path, record.page.content, content) })
      }
    },
    execute: async (input, ctx, effects) => {
      const { head, record, expectedVersion, version } = await prepareRestore(wiki, input, ctx)
      const identity = await writeIdentity(runs, { ...ctx.run, signal: ctx.signal })
      const restored = await Effect.runPromise(
        wiki
          .restoreRevision({
            pageId: record.page.pageId,
            commitId: version.commitId,
            expectedVersion,
            expectedHead: head,
            authority: identity.authority,
            commit: restoreCommit(identity, record.resource.path, version.timestamp)
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
          ? `Restored ${restored.path} to its version saved ${version.timestamp}.`
          : `${restored.path} already matches its version saved ${version.timestamp}.`,
        preview: changed ? "Wiki page restored" : "Wiki page unchanged",
        data: {
          page: writtenPageData(restored),
          restored_from: version.timestamp,
          changed
        },
        ...(changed
          ? { host: pageReceipt({ ctx, page: restored, beforeVersion: expectedVersion }) }
          : {})
      }
    }
  })
]
