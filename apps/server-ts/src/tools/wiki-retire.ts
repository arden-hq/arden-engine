import type { ToolContext } from "@arden-hq/loop"
import { Effect, Schema } from "effect"
import { recordApplied, type CallEffects } from "../execution/tool-effect.js"
import type { Wiki } from "../wiki/service.js"
import type { PageRecord, Snapshot } from "../wiki/snapshot.js"
import type { ServerRunContext } from "./run-context.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { defineServerTool, type ServerTool } from "./define.js"
import {
  WikiPathSchema,
  activePage,
  readablePage,
  loadSnapshot,
  pageNotFound,
  wikiFailure,
  writtenPageData
} from "./wiki.js"
import { writeIdentity, type WikiWriteIdentity } from "./wiki-identity.js"
import { pageReceipt, requireObserved } from "./wiki-records.js"

const ActiveWikiPathSchema = WikiPathSchema.annotate({
  description: "Exact relative POSIX .md path of an active page returned by Wiki search or listing."
})

const ArchiveParametersSchema = Schema.Struct({
  path: ActiveWikiPathSchema
})

const MergeParametersSchema = Schema.Struct({
  path: ActiveWikiPathSchema.annotate({
    description: "Exact path of the page to retire. Its content must already be in `into`."
  }),
  into: ActiveWikiPathSchema.annotate({
    description:
      "Exact path of the active page that now holds the content. The retired path redirects there, so links to it keep working."
  })
})

const mergeArchivedPage = async (input: {
  readonly wiki: Wiki["Service"]
  readonly snapshot: Snapshot
  readonly head: string
  readonly record: PageRecord
  readonly target: string
  readonly ctx: ToolContext<ServerRunContext>
  readonly effects: CallEffects
  readonly identity: WikiWriteIdentity
  readonly expectedVersion: string
}) => {
  const { wiki, snapshot, record, ctx } = input
  const target = readablePage(snapshot, input.target)
  if (target === null) throw pageNotFound(snapshot, input.target)
  const merged = await recordApplied(
    input.effects,
    Effect.runPromise(
      wiki
        .mergeInto({
          pageId: record.page.pageId,
          targetPageId: target.page.pageId,
          expectedVersion: input.expectedVersion,
          expectedHead: input.head,
          authority: input.identity.authority,
          commit: {
            actor: input.identity.actor,
            origin: input.identity.origin,
            reason: `merge wiki page ${record.resource.path} into ${target.resource.path}`
          }
        })
        .pipe(Effect.mapError(wikiFailure)),
      { signal: ctx.signal }
    )
  )
  const retired = (await loadSnapshot(wiki, ctx.signal)).pages.find(
    (page) => page.page.pageId === record.page.pageId
  )
  return {
    result: `Archived ${record.resource.path}; its path now redirects to ${merged.path}.`,
    preview: "Wiki page merged",
    data: { page: writtenPageData(merged), merged_from: record.resource.path, changed: true },
    ...(retired === undefined
      ? {}
      : {
          host: pageReceipt({
            ctx,
            page: {
              pageId: retired.page.pageId,
              path: retired.resource.path,
              title: record.page.title,
              version: retired.resource.versionId
            },
            beforeVersion: input.expectedVersion
          })
        })
  }
}

/**
 * The two ways a page leaves the Wiki. Merging keeps its path opening the page that replaced
 * it; archiving is for a page nothing replaces.
 */
export const makeWikiRetireTools = ({
  wiki,
  runs
}: {
  readonly wiki: Wiki["Service"]
  readonly runs: Pick<RunQueries["Service"], "get" | "cause">
}): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "wiki_archive_page",
    description:
      "Recoverably archive one active Wiki page that no other page replaces. Read it first; revision history is retained. When another page now holds its content, use wiki_merge_page instead, so links keep working. Asks by default.",
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
      destructive: false,
      target: "reported"
    },
    execute: async (input, ctx, effects) => {
      const snapshot = await loadSnapshot(wiki, ctx.signal)
      const record = activePage(snapshot, input.path)
      if (record === null || snapshot.head === null) throw pageNotFound(snapshot, input.path)
      const identity = await writeIdentity(runs, { ...ctx.run, signal: ctx.signal })
      const expectedVersion = requireObserved(ctx.run, record)
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
    name: "wiki_merge_page",
    description:
      "Retire one active Wiki page whose content another page now holds. Read both pages first and move anything unique into the other page before merging. The retired path redirects to the other page, so links keep working, and wiki_restore_page can bring the page back. Asks by default.",
    parameters: Schema.toStandardSchemaV1(MergeParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Merge Wiki Page",
      kind: "tool",
      action: "write",
      default_approval: "ask",
      approval_preview: "Merge one Memory page into another.",
      source: "_wiki",
      scopes: ["memory_capture"],
      unattended_scope: "memory_capture",
      changes_state: true,
      concurrency_group: "wiki_write",
      destructive: false,
      target: "reported"
    },
    execute: async (input, ctx, effects) => {
      const snapshot = await loadSnapshot(wiki, ctx.signal)
      const record = activePage(snapshot, input.path)
      if (record === null || snapshot.head === null) throw pageNotFound(snapshot, input.path)
      const target = activePage(snapshot, input.into)
      if (target === null) throw pageNotFound(snapshot, input.into)
      const identity = await writeIdentity(runs, { ...ctx.run, signal: ctx.signal })
      const expectedVersion = requireObserved(ctx.run, record)
      // The run must have read the page that keeps the content, not only the one it retires.
      requireObserved(ctx.run, target)
      return mergeArchivedPage({
        wiki,
        snapshot,
        head: snapshot.head,
        record,
        target: target.resource.path,
        ctx,
        effects,
        identity,
        expectedVersion
      })
    }
  })
]
