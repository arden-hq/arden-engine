import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import type { WikiArchiveResponse, WikiPage } from "@arden-hq/protocol/wiki"
import { type Array as Arr, Effect, Semaphore } from "effect"
import { randomUUID } from "node:crypto"

import type { PersistedSpace, SpaceStore, SpaceStoreError } from "../persistence/spaces/store.js"
import type { WikiLocationAuthority } from "./authority.js"
import {
  archivePage,
  commitWiki,
  mergePage,
  newPage,
  type WikiCommitIdentity,
  updatePage
} from "./commit.js"
import { requireCurrent, withConflictDetail } from "./conflict.js"
import {
  ensureWikiSpacePage,
  logNoSpacePage,
  restoreWikiSpace,
  type SpaceRestore,
  type WikiSpacePageInput
} from "./space-page.js"
import { makeWikiDirectoryMethods, type WikiCreateDirectoryInput } from "./directories.js"
import { mapRevisionError, WikiError, wikiError } from "./errors.js"
import type { WikiListingMethods } from "./listing.js"
import { formatWikiPage, parseWikiPage, replacementContent } from "./page.js"
import { publishWikiReport, type WikiPublishReportInput } from "./reports.js"
import { loadSnapshot } from "./snapshot.js"

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
  repository: ManagedFileRepositoryShape,
  spaces: SpaceStore["Service"],
  read: WikiListingMethods["read"]
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
    yield* repository.currentRevision.pipe(
      Effect.flatMap((head) =>
        commitWiki(
          { repository, spaces },
          { ...input.commit, authority: input.authority, expectedRevision: head },
          [newPage(pageId, input.path, content)]
        )
      ),
      Effect.mapError(mapRevisionError("create", pageId))
    )
    const page = yield* read(pageId).pipe(
      Effect.mapError((cause) => new WikiError({ ...cause, operation: "create" }))
    )
    return page
  })

  const directoryMethods = makeWikiDirectoryMethods(repository, spaces)
  const createDirectory = Effect.fn("Wiki.createDirectory")(function* (
    input: WikiCreateDirectoryInput
  ) {
    const created = yield* directoryMethods.createDirectory(input)
    const page = yield* read(created.pageId).pipe(
      Effect.mapError((cause) => new WikiError({ ...cause, operation: "create" }))
    )
    return { page, changed: created.changed, adopted: created.adopted }
  })

  const spacePages = Semaphore.makeUnsafe(1)
  const ensureOne = (input: WikiSpacePageInput) =>
    ensureWikiSpacePage(repository, spaces, input).pipe(spacePages.withPermits(1))
  const ensureSpacePage = Effect.fn("Wiki.ensureSpacePage")(function* (input: WikiSpacePageInput) {
    const ensured = yield* ensureOne(input)
    if (ensured === undefined) return undefined
    const created =
      ensured.kind !== "created"
        ? undefined
        : yield* read(ensured.created.pageId).pipe(
            Effect.mapError((cause) => new WikiError({ ...cause, operation: "create" }))
          )
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
    restoreWikiSpace(repository, spaces, spaceId).pipe(spacePages.withPermits(1))

  const publishReport = Effect.fn("Wiki.publishReportAndNotify")(function* (
    input: WikiPublishReportInput
  ) {
    const result = yield* publishWikiReport(repository, spaces, input)
    const page = yield* read(result.pageId)
    return { page, changed: result.changed }
  })

  const update = Effect.fn("Wiki.update")(function* (input: WikiUpdateInput) {
    const page: { readonly pageId?: string } =
      input.edits.length === 1 ? { pageId: input.edits[0].pageId } : {}
    return yield* withConflictDetail(
      repository,
      Effect.gen(function* () {
        if (new Set(input.edits.map((edit) => edit.pageId)).size !== input.edits.length) {
          return yield* wikiError("update", "invalid", "An update names a page twice")
        }
        const snapshot = yield* loadSnapshot(repository, "update")
        // A replayable write read before its head moved may have landed already; its receipt decides
        // whatever is not already current.
        const replay = input.commit.replayKey !== undefined && snapshot.head !== input.expectedHead
        const edits = yield* Effect.forEach(
          input.edits,
          Effect.fn("Wiki.updateWrite")(function* (edit: WikiPageEdit) {
            const current = replay
              ? snapshot.wholeSet.find((record) => record.page.pageId === edit.pageId)
              : yield* requireCurrent(
                  "update",
                  snapshot,
                  edit.pageId,
                  edit.expectedVersion,
                  input.expectedHead
                )
            const content = yield* replacementContent("update", edit.pageId, edit.content)
            return content === current?.page.content
              ? []
              : [updatePage({ resourceId: edit.pageId, versionId: edit.expectedVersion }, content)]
          })
        )
        const writes = edits.flat()
        if (writes.length > 0) {
          yield* commitWiki(
            { repository, spaces },
            { ...input.commit, authority: input.authority, expectedRevision: input.expectedHead },
            writes
          ).pipe(Effect.mapError(mapRevisionError("update", page.pageId)))
        } else {
          const latestHead = yield* repository.currentRevision.pipe(
            Effect.mapError(mapRevisionError("update", page.pageId))
          )
          if (latestHead !== snapshot.head) {
            return yield* wikiError("update", "conflict", "Wiki changed during the update", page)
          }
        }
        return yield* Effect.forEach(
          input.edits,
          (edit) =>
            read(edit.pageId).pipe(
              Effect.mapError((cause) =>
                cause.reason === "not_found"
                  ? wikiError("update", "corrupt", "Updated Wiki page disappeared", {
                      pageId: edit.pageId,
                      cause
                    })
                  : new WikiError({ ...cause, operation: "update" })
              )
            ),
          { concurrency: 8 }
        )
      })
    )
  })

  const archive = Effect.fn("Wiki.archive")(function* (
    input: WikiArchiveInput
  ): Effect.fn.Return<WikiArchiveResponse, WikiError> {
    return yield* withConflictDetail(
      repository,
      Effect.gen(function* () {
        const snapshot = yield* loadSnapshot(repository, "archive")
        const current = yield* requireCurrent(
          "archive",
          snapshot,
          input.pageId,
          input.expectedVersion,
          input.expectedHead
        )
        const committed = yield* commitWiki(
          { repository, spaces },
          { ...input.commit, authority: input.authority, expectedRevision: input.expectedHead },
          [archivePage(current.resource)]
        ).pipe(Effect.mapError(mapRevisionError("archive", input.pageId)))
        const archived = committed.commit.changes.find(
          (change) => change.after?.resourceId === input.pageId
        )?.after
        if (archived === undefined || archived === null || archived.state !== "archived") {
          return yield* wikiError("archive", "corrupt", "Archive commit did not contain the page", {
            pageId: input.pageId
          })
        }
        return {
          pageId: input.pageId,
          path: archived.path,
          resourceState: "archived" as const,
          version: archived.versionId,
          repositoryHead: committed.commit.commitId
        }
      })
    )
  })

  const mergeInto = Effect.fn("Wiki.mergeInto")(function* (
    input: WikiArchiveInput & { readonly targetPageId: string }
  ): Effect.fn.Return<WikiPage, WikiError> {
    return yield* withConflictDetail(
      repository,
      Effect.gen(function* () {
        const snapshot = yield* loadSnapshot(repository, "merge")
        const current = yield* requireCurrent(
          "merge",
          snapshot,
          input.pageId,
          input.expectedVersion,
          input.expectedHead
        )
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
        yield* commitWiki(
          { repository, spaces },
          { ...input.commit, authority: input.authority, expectedRevision: input.expectedHead },
          [
            mergePage(current.resource, {
              pageId: current.page.pageId,
              title: current.page.title,
              redirectTo: target.page.pageId
            })
          ]
        ).pipe(Effect.mapError(mapRevisionError("merge", input.pageId)))
        return yield* read(target.page.pageId).pipe(
          Effect.mapError((cause) => new WikiError({ ...cause, operation: "merge" }))
        )
      })
    )
  })

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
