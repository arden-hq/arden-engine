import type { ToolContext } from "@arden-hq/loop"
import { Effect } from "effect"
import { recordApplied, type CallEffects } from "../execution/tool-effect.js"
import type { Wiki } from "../wiki/service.js"
import type { PageRecord, Snapshot } from "../wiki/snapshot.js"
import type { ServerRunContext } from "./run-context.js"
import { readablePage, loadSnapshot, pageNotFound, wikiFailure, writtenPageData } from "./wiki.js"
import type { WikiWriteIdentity } from "./wiki-identity.js"
import { pageReceipt } from "./wiki-records.js"

export const mergeArchivedPage = async (input: {
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
