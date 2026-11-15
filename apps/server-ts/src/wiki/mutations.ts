import type { WikiArchiveResponse, WikiPage } from "@arden-hq/protocol/wiki"
import { type Array as Arr, Effect, Semaphore } from "effect"
import { randomUUID } from "node:crypto"

import type { PersistedSpace, SpaceStore, SpaceStoreError } from "../persistence/spaces/store.js"
import type { WikiLocationAuthority } from "./authority.js"
import { archivePage, mergePage, newPage, type WikiCommitIdentity, updatePage } from "./commit.js"
import {
  ensureWikiSpacePage,
  logNoSpacePage,
  restoreWikiSpace,
  type SpaceRestore,
  type WikiSpacePageInput
} from "./space-page.js"
import { createWikiDirectory, type WikiCreateDirectoryInput } from "./directories.js"
import { type WikiError, wikiError } from "./errors.js"
import { pageIn, writerOf, type WikiChanges } from "./page-change.js"
import { formatWikiPage, parseWikiPage, replacementContent } from "./page.js"
import { publishWikiReport, type WikiPublishReportInput } from "./reports.js"

interface WikiPageEdit {
  readonly pageId: string
  readonly content: string
  readonly expectedVersion: string
}

interface WikiUpdateInput {
  /** Saved in one commit: every page or none. */
  readonly edits: Arr.NonEmptyReadonlyArray<WikiPageEdit>
  readonly expectedHead: string
  readonly authority: WikiLocationAuthority
  readonly commit: WikiCommitIdentity
}

interface WikiCreateInput {
  readonly path: string
  readonly title: string
  readonly body: string
  readonly authority: WikiLocationAuthority
  readonly commit: WikiCommitIdentity
}

interface WikiCreateDirectoryResult {
  readonly page: WikiPage
  readonly changed: boolean
  readonly adopted: boolean
}

interface WikiArchiveInput {
  readonly pageId: string
  readonly expectedVersion: string
  readonly expectedHead: string
  readonly authority: WikiLocationAuthority
  readonly commit: WikiCommitIdentity
}

interface SpacePageCounts {
  readonly active: number
  readonly kept: number
  readonly rebound: number
  readonly made: number
  readonly failed: number
}

export interface WikiMutationMethods {
  readonly create: (input: WikiCreateInput) => Effect.Effect<WikiPage, WikiError>
  readonly createDirectory: (
    input: WikiCreateDirectoryInput
  ) => Effect.Effect<WikiCreateDirectoryResult, WikiError>
  readonly ensureSpacePage: (
    input: WikiSpacePageInput
  ) => Effect.Effect<
    { readonly space: PersistedSpace; readonly created: WikiPage | undefined } | undefined,
    WikiError
  >
  /** Gives every active Space a page, and counts what that took. */
  readonly ensureSpacePages: () => Effect.Effect<SpacePageCounts, WikiError>
  readonly restoreSpace: (
    spaceId: string
  ) => Effect.Effect<SpaceRestore | null, WikiError | SpaceStoreError>
  readonly publishReport: (input: WikiPublishReportInput) => Effect.Effect<
    {
      readonly page: WikiPage
      readonly changed: boolean
    },
    WikiError
  >
  readonly update: (input: WikiUpdateInput) => Effect.Effect<Arr.NonEmptyArray<WikiPage>, WikiError>
  readonly archive: (input: WikiArchiveInput) => Effect.Effect<WikiArchiveResponse, WikiError>
  readonly mergeInto: (
    input: WikiArchiveInput & { readonly targetPageId: string }
  ) => Effect.Effect<WikiPage, WikiError>
}

export const makeWikiMutationMethods = (
  changes: WikiChanges,
  spaces: SpaceStore["Service"]
): WikiMutationMethods => {
  const create = Effect.fn("Wiki.create")(function* (input: WikiCreateInput) {
    const pageId = randomUUID()
    const content = formatWikiPage({
      pageId,
      title: input.title,
      aliases: [],
      lifecycle: "active",
      redirectTo: null,
      metadata: {},
      body: input.body
    })
    yield* parseWikiPage(content, pageId).pipe(
      Effect.mapError((cause) => wikiError("create", "invalid", cause.message, { pageId, cause }))
    )
    yield* changes.change(writerOf("create", input), () =>
      Effect.succeed({ writes: [newPage(pageId, input.path, content)], value: undefined })
    )
    return yield* changes.saved("create", pageId)
  })

  const createDirectory = Effect.fn("Wiki.createDirectory")(function* (
    input: WikiCreateDirectoryInput
  ) {
    const created = yield* createWikiDirectory(changes, spaces, input)
    const page = yield* changes.saved("create", created.pageId)
    return { page, changed: created.changed, adopted: created.adopted }
  })

  const spacePages = Semaphore.makeUnsafe(1)
  const ensureOne = (input: WikiSpacePageInput) =>
    ensureWikiSpacePage(changes, spaces, input).pipe(spacePages.withPermits(1))
  const ensureSpacePage = Effect.fn("Wiki.ensureSpacePage")(function* (input: WikiSpacePageInput) {
    const ensured = yield* ensureOne(input)
    if (ensured === undefined) return undefined
    const created =
      ensured.kind !== "created"
        ? undefined
        : yield* changes.saved("create", ensured.created.pageId)
    return { space: ensured.space, created }
  })
  const ensureSpacePages = Effect.fn("Wiki.ensureSpacePages")(function* () {
    const active = yield* spaces
      .list()
      .pipe(
        Effect.mapError((cause) =>
          wikiError("create", "storage", "Could not list the Spaces", { cause })
        )
      )
    const counts = { active: active.length, kept: 0, rebound: 0, made: 0, failed: 0 }
    for (const space of active) {
      const ensured = yield* ensureOne({ spaceId: space.space_id }).pipe(
        Effect.catch((error) => logNoSpacePage(space.space_id, error).pipe(Effect.as(null)))
      )
      if (ensured === null) counts.failed += 1
      else if (ensured === undefined) counts.active -= 1
      else if (ensured.kind === "created") counts.made += 1
      else counts[ensured.kind] += 1
    }
    return counts satisfies SpacePageCounts
  })
  const restoreSpace = (spaceId: string) =>
    restoreWikiSpace(changes, spaces, spaceId).pipe(spacePages.withPermits(1))

  const publishReport = Effect.fn("Wiki.publishReportAndNotify")(function* (
    input: WikiPublishReportInput
  ) {
    const result = yield* publishWikiReport(changes, spaces, input)
    const page = yield* changes.saved("create", result.pageId)
    return { page, changed: result.changed }
  })

  const update = (input: WikiUpdateInput) =>
    new Set(input.edits.map((edit) => edit.pageId)).size !== input.edits.length
      ? wikiError("update", "invalid", "An update names a page twice")
      : changes
          .change(writerOf("update", input, input.expectedHead, input.edits), (snapshot) =>
            Effect.forEach(input.edits, (edit) =>
              replacementContent("update", edit.pageId, edit.content).pipe(
                Effect.map((content) =>
                  content ===
                  snapshot.wholeSet.find((record) => record.page.pageId === edit.pageId)?.page
                    .content
                    ? []
                    : [
                        updatePage(
                          { resourceId: edit.pageId, versionId: edit.expectedVersion },
                          content
                        )
                      ]
                )
              )
            ).pipe(Effect.map((writes) => ({ writes: writes.flat(), value: undefined })))
          )
          .pipe(
            Effect.andThen(
              Effect.forEach(input.edits, (edit) => changes.saved("update", edit.pageId), {
                concurrency: 8
              })
            )
          )

  const archive = (input: WikiArchiveInput): Effect.Effect<WikiArchiveResponse, WikiError> =>
    changes
      .change(writerOf("archive", input, input.expectedHead, [input]), (snapshot) =>
        pageIn("archive", snapshot, input.pageId).pipe(
          Effect.map((current) => ({ writes: [archivePage(current.resource)], value: undefined }))
        )
      )
      .pipe(
        Effect.flatMap(({ commit }) => {
          const archived = commit?.commit.changes.find(
            (change) => change.after?.resourceId === input.pageId
          )?.after
          return commit === undefined ||
            archived === undefined ||
            archived === null ||
            archived.state !== "archived"
            ? wikiError("archive", "corrupt", "Archive commit did not contain the page", {
                pageId: input.pageId
              })
            : Effect.succeed({
                pageId: input.pageId,
                path: archived.path,
                resourceState: "archived" as const,
                version: archived.versionId,
                repositoryHead: commit.commit.commitId
              })
        })
      )

  const mergeInto = (input: WikiArchiveInput & { readonly targetPageId: string }) =>
    changes
      .change(
        writerOf("merge", input, input.expectedHead, [input]),
        Effect.fn("Wiki.planMerge")(function* (snapshot) {
          const current = yield* pageIn("merge", snapshot, input.pageId)
          const target = snapshot.wholeSet.find(
            (record) =>
              record.page.pageId === input.targetPageId && record.page.lifecycle === "active"
          )
          if (target === undefined || target.page.pageId === input.pageId) {
            return yield* wikiError(
              "merge",
              "invalid",
              "A page merges only into another active Wiki page",
              { pageId: input.pageId }
            )
          }
          return {
            writes: [
              mergePage(current.resource, {
                pageId: current.page.pageId,
                title: current.page.title,
                redirectTo: target.page.pageId
              })
            ],
            value: target.page.pageId
          }
        })
      )
      .pipe(Effect.flatMap(({ value }) => changes.saved("merge", value)))

  return {
    create,
    createDirectory,
    ensureSpacePage,
    ensureSpacePages,
    restoreSpace,
    publishReport,
    update,
    archive,
    mergeInto
  }
}
