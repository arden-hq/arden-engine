import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import {
  createPage,
  movePage,
  ownerInApp,
  updatePage,
  type WikiCommitIdentity,
  type WikiWrite
} from "./commit.js"
import type { WikiRenamePlan } from "@arden-hq/protocol/wiki"
import { Effect } from "effect"
import { posix } from "node:path"

import type { WikiLocationAuthority } from "./authority.js"
import { mapRevisionError, wikiError, type WikiError } from "./errors.js"
import { pageWikiLinks, rewriteWikiLinkTargets } from "./links.js"
import { pageIn, writerOf, type WikiChanges, type WikiPlan } from "./page-change.js"
import {
  formatRedirectPage,
  isReadme,
  namesTakenAt,
  takesName,
  parseWikiPage,
  reviseWikiPage
} from "./page.js"
import {
  nameTakenBy,
  pageNameIndex,
  resolveWikiLinkTarget,
  type PageRecord,
  type Snapshot
} from "./snapshot.js"

/** Who renames when the owner renames a page in the app. */
export const OWNER_RENAME: WikiCommitIdentity = ownerInApp("rename wiki page", "desktop.rename")

interface WikiRenameInput {
  readonly pageId: string
  readonly newPath: string
  readonly newTitle: string
  readonly expectedVersion: string
  /** The head the plan is made from and the rename is guarded by: any change to Memory since
   *  refuses the rename. */
  readonly expectedHead: string
  readonly authority: WikiLocationAuthority
  readonly commit: WikiCommitIdentity
}

export interface WikiRenameMethods {
  /** The pages and links a rename would change, refused by every rule its commit would meet;
   *  saves nothing. */
  readonly planRename: (input: WikiRenameInput) => Effect.Effect<WikiRenamePlan, WikiError>
  /** Saves that plan as one commit. */
  readonly rename: (input: WikiRenameInput) => Effect.Effect<WikiRenamePlan, WikiError>
}

const linkTarget = (path: string, keepExtension: boolean): string => {
  if (keepExtension) return path
  if (isReadme(path)) {
    const directory = posix.dirname(path)
    return directory === "." ? posix.basename(path, ".md") : directory
  }
  return path.endsWith(".md") ? path.slice(0, -3) : path
}

const requireRenamable = Effect.fn("WikiRename.requireRenamable")(function* (
  snapshot: Snapshot,
  current: PageRecord,
  newPath: string
): Effect.fn.Return<void, WikiError> {
  const { pageId } = current.page
  if (current.page.lifecycle !== "active") {
    return yield* wikiError("rename", "invalid", "Only active Wiki pages can be renamed", {
      pageId
    })
  }
  if (newPath.toLowerCase() === current.resource.path.toLowerCase()) {
    return yield* wikiError("rename", "invalid", "A Wiki rename requires a different path", {
      pageId
    })
  }
  if (takesName(namesTakenAt([newPath]), current.resource.path)) {
    return yield* wikiError(
      "rename",
      "blocked",
      "The new Wiki path conflicts with the redirect kept at the old path",
      { pageId }
    )
  }
  if (nameTakenBy(snapshot, newPath, pageId) !== undefined) {
    return yield* wikiError(
      "rename",
      "blocked",
      "Another Wiki page already owns the new path or link name",
      { pageId }
    )
  }
  if (isReadme(current.resource.path)) {
    const prefix = `${posix.dirname(current.resource.path)}/`
    if (
      snapshot.wholeSet.some(
        (record) =>
          record.page.pageId !== pageId &&
          record.page.lifecycle === "active" &&
          record.resource.path.startsWith(prefix)
      )
    ) {
      return yield* wikiError(
        "rename",
        "blocked",
        "Move child pages before renaming this directory page",
        { pageId }
      )
    }
  }
})

const renamePlan = Effect.fn("WikiRename.plan")(function* (
  repository: ManagedFileRepositoryShape,
  snapshot: Snapshot,
  input: WikiRenameInput
): Effect.fn.Return<WikiPlan<WikiRenamePlan>, WikiError> {
  const source = yield* pageIn("rename", snapshot, input.pageId)
  yield* requireRenamable(snapshot, source, input.newPath)
  const pages = snapshot.wholeSet
  const byId = new Map(pages.map((record) => [record.page.pageId, record] as const))
  const names = pageNameIndex(pages)
  const rewrites: Array<{ record: PageRecord; content: string }> = []
  let movedBody = source.page.body
  let linkCount = 0
  let pageCount = 0

  for (const record of pages) {
    if (record.page.lifecycle !== "active") continue
    const replacements = new Map()
    for (const token of pageWikiLinks(record)) {
      if (
        token.page !== null &&
        resolveWikiLinkTarget(byId, names, record.page.pageId, token) === source.page.pageId
      ) {
        replacements.set(token, linkTarget(input.newPath, token.page.toLowerCase().endsWith(".md")))
      }
    }
    if (replacements.size === 0) continue
    const body = yield* Effect.try({
      try: () => rewriteWikiLinkTargets(record.page.body, replacements),
      catch: (cause) =>
        wikiError("rename", "invalid", "Could not rewrite Wiki links", {
          pageId: record.page.pageId,
          cause
        })
    })
    linkCount += replacements.size
    pageCount += 1
    if (record.page.pageId === source.page.pageId) {
      movedBody = body
    } else {
      rewrites.push({
        record,
        content: yield* reviseWikiPage(record.page, { body }).pipe(
          Effect.mapError((cause) =>
            wikiError("rename", "invalid", "Could not preserve Wiki page content", {
              pageId: record.page.pageId,
              cause
            })
          )
        )
      })
    }
  }

  const redirectId = `wiki-redirect:${source.resource.versionId}`
  const resources = yield* repository
    .listResources({ at: snapshot.head, includeArchived: true })
    .pipe(Effect.mapError(mapRevisionError("rename", source.page.pageId)))
  if (
    resources.some((resource) => resource.resourceId.toLowerCase() === redirectId.toLowerCase())
  ) {
    return yield* wikiError("rename", "blocked", "A redirect already owns the previous Wiki path", {
      pageId: source.page.pageId
    })
  }

  const movedContent = yield* reviseWikiPage(source.page, {
    title: input.newTitle,
    body: movedBody
  }).pipe(
    Effect.mapError((cause) =>
      wikiError("rename", "invalid", "Could not preserve the renamed Wiki page", {
        pageId: source.page.pageId,
        cause
      })
    )
  )
  const redirectContent = formatRedirectPage({
    pageId: redirectId,
    title: source.page.title,
    redirectTo: source.page.pageId
  })
  yield* Effect.forEach(
    [
      [source.page.pageId, movedContent],
      [redirectId, redirectContent],
      ...rewrites.map(({ record, content }) => [record.page.pageId, content] as const)
    ] as const,
    ([pageId, content]) =>
      parseWikiPage(content, pageId).pipe(
        Effect.mapError((cause) =>
          wikiError("rename", "invalid", "The Wiki rename would create an invalid page", {
            pageId,
            cause
          })
        )
      ),
    { discard: true }
  )

  const writes: ReadonlyArray<WikiWrite> = [
    movePage(source.resource, input.newPath, movedContent),
    createPage(redirectId, source.resource.path, redirectContent),
    ...rewrites.map(({ record, content }) => updatePage(record.resource, content))
  ]
  return {
    writes,
    value: {
      oldPath: source.resource.path,
      newPath: input.newPath,
      oldTitle: source.page.title,
      newTitle: input.newTitle,
      linkCount,
      pageCount
    }
  }
})

export const makeWikiRenameMethods = (
  repository: ManagedFileRepositoryShape,
  changes: WikiChanges
): WikiRenameMethods => {
  const writer = (input: WikiRenameInput) => writerOf("rename", input, input.expectedHead, [input])
  const plan = (input: WikiRenameInput) => (snapshot: Snapshot) =>
    renamePlan(repository, snapshot, input)
  return {
    planRename: (input) => changes.preview(writer(input), plan(input)),
    rename: (input) =>
      changes.change(writer(input), plan(input)).pipe(Effect.map(({ value }) => value))
  }
}
