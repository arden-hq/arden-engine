import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"
import { Array as Arr, Effect } from "effect"
import { RunQueries } from "../persistence/runs/queries.js"
import { writeIdentity, type WikiWriteIdentity } from "./wiki-identity.js"
import type { ServerRunContext } from "./run-context.js"
import type { WikiLocationAuthority } from "../wiki/authority.js"
import type { WikiCommitIdentity } from "../wiki/origin.js"
import { captureSaveKey } from "../wiki/capture.js"
import type { WikiError } from "../wiki/errors.js"
import { Wiki } from "../wiki/service.js"
import type { WikiPage } from "@arden-hq/protocol/wiki"
import { type PageRecord, type Snapshot, pageLifecycle } from "../wiki/snapshot.js"
import { type CallEffects } from "../execution/tool-effect.js"
import { pageReceipt, pagesReceipt } from "./wiki-records.js"
import { activePage, loadSnapshot, pageNotFound, wikiFailure } from "./wiki-access.js"

export interface ChangedPage {
  readonly pageId: string
  readonly path: string
  readonly title: string
  readonly version: string
}

export interface SavedPage<Page extends ChangedPage = ChangedPage> {
  readonly page: Page
  readonly before: string
}

export type Found<Paths> = { readonly [K in keyof Paths]: PageRecord }

export interface PagesTarget<Paths> {
  readonly head: string
  readonly records: Found<Paths>
  readonly identity: WikiWriteIdentity
  readonly writer: (reason: string) => {
    readonly authority: WikiLocationAuthority
    readonly commit: WikiCommitIdentity
  }
  readonly run: <A>(effect: Effect.Effect<A, WikiError>) => Promise<A>
}

export interface WikiToolServices {
  readonly wiki: Wiki["Service"]
  readonly runs: Pick<RunQueries["Service"], "get" | "cause">
}

export const keptPage = (
  record: PageRecord
): SavedPage<
  Pick<WikiPage, "pageId" | "path" | "title" | "version" | "aliases" | "lifecycle">
> => ({
  page: {
    pageId: record.page.pageId,
    path: record.resource.path,
    title: record.page.title,
    version: record.resource.versionId,
    aliases: record.page.aliases,
    lifecycle: pageLifecycle(record.page)
  },
  before: record.resource.versionId
})

const findAll = <const Paths extends Arr.NonEmptyReadonlyArray<string>>(
  paths: Paths,
  find: (path: string) => PageRecord
): Found<Paths> => paths.map(find) as unknown as Found<Paths>

export const changePages = async <
  const Paths extends Arr.NonEmptyReadonlyArray<string>,
  Page extends ChangedPage
>(
  { wiki, runs }: WikiToolServices,
  ctx: ToolContext<ServerRunContext>,
  effects: CallEffects,
  request: {
    readonly input: unknown
    readonly paths: Paths
    readonly find?: (snapshot: Snapshot, path: string) => PageRecord | null
    readonly save: (
      target: PagesTarget<Paths>
    ) => Promise<Arr.NonEmptyReadonlyArray<SavedPage<Page>>>
  }
): Promise<{
  records: Found<Paths>
  saved: readonly [SavedPage<Page>, ...SavedPage<Page>[]]
  changed: boolean
  receipt: Readonly<Record<string, unknown>> | undefined
}> => {
  const snapshot = await loadSnapshot(wiki, ctx.signal)
  const head = snapshot.head
  if (head === null) throw pageNotFound(snapshot, request.paths[0])
  const records = findAll(request.paths, (path) => {
    const record = (request.find ?? activePage)(snapshot, path)
    if (record === null) throw pageNotFound(snapshot, path)
    return record
  })
  const identity = await writeIdentity(runs, { ...ctx.run, signal: ctx.signal })
  const run = <A>(effect: Effect.Effect<A, WikiError>) =>
    Effect.runPromise(effect.pipe(Effect.mapError(wikiFailure)), { signal: ctx.signal })
  const replayKey =
    identity.captureBatch === null ? undefined : captureSaveKey(ctx.run.runId, request.input)
  if (replayKey !== undefined && (await run(wiki.hasCaptureReceipt(replayKey))))
    throw new ToolExecutionError(
      "This run already saved this exact request; nothing was saved again.",
      {
        preview: "Already saved",
        retryable: false
      }
    )
  const saved = await request.save({
    head,
    records,
    identity,
    writer: (reason) => ({
      authority: identity.authority,
      commit: {
        actor: identity.actor,
        origin: identity.origin,
        reason,
        ...(replayKey === undefined ? {} : { replayKey })
      }
    }),
    run
  })
  for (const { page } of saved) ctx.run.observations.observe(page.pageId, page.version)
  const moved = saved.filter(({ page, before }) => page.version !== before)
  if (moved.length > 0) effects.applied()
  else effects.unchanged()
  const [one] = moved
  return {
    records,
    saved,
    changed: one !== undefined,
    receipt:
      moved.length === 1 && one !== undefined
        ? pageReceipt({ ctx, page: one.page, beforeVersion: one.before })
        : pagesReceipt(
            ctx,
            moved.map(({ page, before }) => ({
              ...page,
              beforeVersion: before,
              afterVersion: page.version
            }))
          )
  }
}
