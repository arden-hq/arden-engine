import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "./authority.js"
import {
  requireAutomatedRecordWrite,
  requireAutomatedRetirement
} from "./commit-rules-automated.js"
import { ruleError, type CommitView, type ResolvedWrite } from "./commit-rule-types.js"
import type {
  ManagedFileRepositoryShape,
  ResourceVersion,
  RevisionError
} from "@arden-hq/revisions/effect"
import { Effect, Option } from "effect"
import { posix } from "node:path"

import {
  corePageBudget,
  createRefusal,
  overPageLimit,
  pageLimitRefusal
} from "../memory/core-memory.js"
import {
  requireNewPagePlace,
  requireWikiWritePaths,
  resolveWikiWriteBoundary
} from "./authority.js"
import {
  PAGE_KIND,
  pageKind,
  producingAutomation,
  recordFolders,
  type RecordFolders
} from "./collections.js"
import { RESOURCE_STATE } from "@arden-hq/revisions/effect"
import { WIKI_PAGE_LIFECYCLE } from "@arden-hq/protocol/wiki"
import { WIKI_OPERATION, WIKI_PAGE_ACTION } from "./commit-write-types.js"
import { wikiError } from "./errors.js"
import {
  aliasesAreHuman,
  isReadme,
  namesTakenAt,
  parseWikiPage,
  takesName,
  type ParsedWikiPage
} from "./page.js"
import { guardedLines, openRetractions, putBack, retractionRefusal } from "./retraction.js"
import { brokenRedirect, loadSnapshot, type PageRecord } from "./snapshot.js"
import { spacePageCheck } from "./space-index.js"
import {
  isAutomatedOrigin,
  isCaptureWriter,
  isOutsideEdit,
  isOwnerOrigin,
  isSpacePageWriter,
  isUpkeep,
  type WikiCommitOrigin
} from "./origin.js"
import { codeOwnedPage, isCodeOwnedPage } from "./code-owned-pages.js"
import {
  type WikiWriter,
  type WikiWrite,
  decoder,
  type WikiCommitError,
  type WikiCommitPoint
} from "./commit-write-types.js"

const readPage = (
  bytes: Uint8Array | null | undefined
): Effect.Effect<Option.Option<ParsedWikiPage>> =>
  bytes === null || bytes === undefined
    ? Effect.succeed(Option.none())
    : parseWikiPage(decoder.decode(bytes)).pipe(Effect.option)

const resolveWrite = Effect.fn("Wiki.resolveWrite")(function* (
  repository: ManagedFileRepositoryShape,
  { action, operation }: WikiWrite
): Effect.fn.Return<ResolvedWrite, RevisionError> {
  const before =
    operation._tag === WIKI_OPERATION.Create ? null : yield* repository.get(operation.resourceId)
  const moved = "path" in operation ? operation.path : undefined
  const given = "content" in operation ? operation.content : undefined
  const beforeContent = yield* Effect.cached(
    before === null ? Effect.succeed(null) : repository.readVersion(before)
  )
  return {
    action,
    resourceId: operation.resourceId,
    before,
    path: {
      before: before?.path,
      after: operation._tag === WIKI_OPERATION.Archive ? undefined : (moved ?? before?.path)
    },
    given,
    page: yield* readPage(given),
    beforeContent,
    pageBefore: yield* Effect.cached(beforeContent.pipe(Effect.flatMap(readPage)))
  }
})

const requireHumanAliases = ({ page, resourceId }: ResolvedWrite) =>
  Option.isNone(page) || aliasesAreHuman(page.value.title, page.value.aliases)
    ? Effect.void
    : ruleError("aliases", `Memory page ${resourceId} keeps a path or a repeated name as an alias`)

const refuseGrowthOverLimit = Effect.fn("Wiki.refuseGrowthOverLimit")(function* (
  { origin }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  const path = write.path.after
  if (path === undefined || corePageBudget({ path, pageId: write.resourceId }) === undefined) return
  const overAt = (at: string, page: Option.Option<ParsedWikiPage>) =>
    Option.isNone(page)
      ? undefined
      : overPageLimit({ path: at, pageId: write.resourceId, body: page.value.body })
  const over = overAt(path, write.given === undefined ? yield* write.pageBefore : write.page)
  if (over === undefined) return
  const was =
    write.before?.state === RESOURCE_STATE.active
      ? overAt(write.before.path, yield* write.pageBefore)
      : undefined
  if (was !== undefined && over.chars <= was.chars) return
  return yield* ruleError("size", pageLimitRefusal(isOwnerOrigin(origin), path, over))
})

const currentRecordFolders = Effect.fn("Wiki.currentRecordFolders")(function* (
  repository: ManagedFileRepositoryShape,
  active: Effect.Effect<ReadonlyArray<ResourceVersion>, RevisionError>
): Effect.fn.Return<RecordFolders, RevisionError> {
  const readmes = (yield* active).filter((resource) => isReadme(resource.path))
  const pages = yield* Effect.forEach(readmes, (resource) =>
    repository
      .readVersion(resource)
      .pipe(
        Effect.flatMap(readPage),
        Effect.map(Option.map((page): PageRecord => ({ resource, page })))
      )
  )
  return recordFolders(pages.flatMap(Option.toArray))
})

const occupiedAfter = (
  active: ReadonlyArray<ResourceVersion>,
  writes: ReadonlyArray<ResolvedWrite>
): ReadonlyMap<string, string> => {
  const paths = new Map(active.map((resource) => [resource.resourceId, resource.path] as const))
  for (const write of writes) {
    if (write.path.after === undefined) paths.delete(write.resourceId)
    else paths.set(write.resourceId, write.path.after)
  }
  return paths
}

const readmeBesideItsPage = (one: string, other: string): boolean => {
  const [readme, page] = isReadme(one) ? [one, other] : [other, one]
  return isReadme(readme) && `${posix.dirname(readme)}.md`.toLowerCase() === page.toLowerCase()
}

const requireNameFree = Effect.fn("Wiki.requireNameFree")(function* (
  { occupied }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  const path = write.path.after
  if (path === undefined) return
  if (write.before?.state === RESOURCE_STATE.active && write.path.before === path) return
  const wanted = namesTakenAt([path])
  for (const [resourceId, other] of yield* occupied) {
    if (resourceId === write.resourceId || !takesName(wanted, other)) continue
    if (readmeBesideItsPage(path, other)) continue
    return yield* ruleError(
      "names",
      `${path} would take a path or link name that ${other} holds. Nothing was saved. Choose another path.`
    )
  }
})

const requireNotRecord = Effect.fn("Wiki.requireNotRecord")(function* (
  { folders }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  for (const path of [write.path.before, write.path.after]) {
    if (path === undefined) continue
    const kind = pageKind(yield* folders, path)
    if (kind.kind === PAGE_KIND.knowledge) continue
    return yield* ruleError(
      "records",
      `${path} is ${kind.kind === PAGE_KIND.record ? "a record" : "the contract"} of ${kind.folder.directory}/, kept as its producer wrote it. ` +
        "Wiki Maintenance reads it but does not change it. Nothing was saved. Put what it says on a subject page instead."
    )
  }
})

const requireNoMoveIntoRecords = Effect.fn("Wiki.requireNoMoveIntoRecords")(function* (
  { folders }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  if (write.action !== WIKI_PAGE_ACTION.move || write.path.after === undefined) return
  const producer = producingAutomation(yield* folders, write.path.after)
  if (producer === undefined) return
  return yield* ruleError(
    "records",
    `${write.path.after} is in the record folder of Automation ${producer}, which only it fills, by publishing reports. Nothing was moved.`
  )
})

const requireSpacePageKept = Effect.fn("Wiki.requireSpacePageKept")(function* (
  { origin, spaceOwns }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  const path = write.path.before
  if (path === undefined) return
  const retires = write.action === WIKI_PAGE_ACTION.merge || write.path.after !== path
  if (!retires && !(write.action === WIKI_PAGE_ACTION.restoreVersion && isCaptureWriter(origin)))
    return
  if (!(yield* spaceOwns(write.resourceId, path))) return
  return yield* ruleError(
    "space",
    retires
      ? `${path} is a Space's own page. Move or archive the Space first. Nothing was saved.`
      : `${path} belongs to a Space. Capture does not restore an earlier version of a Space's page. Nothing was saved.`
  )
})

const requireRedirectOnlyByMerge = Effect.fn("Wiki.requireRedirectOnlyByMerge")(function* (
  _view: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  const { page } = write
  if (write.before === null || write.action === WIKI_PAGE_ACTION.merge) return
  if (Option.isNone(page) || page.value.lifecycle !== WIKI_PAGE_LIFECYCLE.redirect) return
  return yield* ruleError(
    "retire",
    `${write.before.path} would become a redirect, which only a merge makes. Nothing was saved.`
  )
})

const keepsCodeOwnedPage = (origin: WikiCommitOrigin, write: ResolvedWrite): boolean => {
  switch (write.action) {
    case WIKI_PAGE_ACTION.create:
    case WIKI_PAGE_ACTION.newPage:
    case WIKI_PAGE_ACTION.publish:
      if (write.before === null)
        return codeOwnedPage(write.path.after ?? "")?.madeBy === origin.kind
      break
    case WIKI_PAGE_ACTION.archive:
      return false
    case WIKI_PAGE_ACTION.move:
      if (write.path.after !== write.path.before) return false
      break
    case WIKI_PAGE_ACTION.edit:
    case WIKI_PAGE_ACTION.restoreVersion:
    case WIKI_PAGE_ACTION.merge:
    case WIKI_PAGE_ACTION.restoreArchived:
      break
  }
  return Option.isNone(write.page) || write.page.value.lifecycle === WIKI_PAGE_LIFECYCLE.active
}

const requireCodeOwnedPageKept = Effect.fn("Wiki.requireCodeOwnedPageKept")(function* (
  { origin }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  const path = [write.path.before, write.path.after].find(
    (candidate) => candidate !== undefined && isCodeOwnedPage(candidate)
  )
  if (path === undefined) return
  if (!isOwnerOrigin(origin))
    return yield* ruleError(
      "code_owned",
      `${path} is kept by Arden for the owner. Nothing was saved; leave it unchanged.`
    )
  if (keepsCodeOwnedPage(origin, write)) return
  return yield* ruleError(
    "code_owned",
    `${path} cannot be made, moved, renamed, merged or archived by hand. Nothing was saved. ${path} ${codeOwnedPage(path)?.holds ?? ""}`
  )
})

const pageBody = (bytes: Uint8Array): Effect.Effect<string> => {
  const text = decoder.decode(bytes)
  return parseWikiPage(text).pipe(
    Effect.map((page) => page.body),
    Effect.orElseSucceed(() => text)
  )
}

const keepsForgottenLines = (origin: WikiCommitOrigin): boolean =>
  !isOwnerOrigin(origin) && !isSpacePageWriter(origin)

const requireNoRetractedLine = Effect.fn("Wiki.requireNoRetractedLine")(function* (
  { guarded }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  const path = write.path.after
  if (path === undefined) return
  const lines = yield* guarded
  if (lines.size === 0) return
  const source =
    write.given ??
    (write.action === WIKI_PAGE_ACTION.restoreArchived ? yield* write.beforeContent : null)
  if (isCodeOwnedPage(path) || source === null) return
  const after = yield* pageBody(source)
  const kept = write.before?.state === RESOURCE_STATE.active
  const had = kept ? yield* pageBody((yield* write.beforeContent) ?? new Uint8Array()) : undefined
  const entry = putBack(lines, had, after)
  if (entry !== undefined) return yield* ruleError("retraction", retractionRefusal(path, entry))
})

const requireNewPagePath = (_view: CommitView, write: ResolvedWrite) => {
  const path = write.action === WIKI_PAGE_ACTION.newPage ? write.path.after : undefined
  const refused = path === undefined ? undefined : createRefusal(path)
  return refused === undefined ? Effect.void : wikiError("create", refused.code, refused.message)
}

const requireActivePage = Effect.fn("Wiki.requireActivePage")(function* (
  _view: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  if (
    write.action !== WIKI_PAGE_ACTION.edit &&
    write.action !== WIKI_PAGE_ACTION.archive &&
    write.action !== WIKI_PAGE_ACTION.merge
  )
    return
  const page = yield* write.pageBefore
  if (Option.isNone(page) || page.value.lifecycle === WIKI_PAGE_LIFECYCLE.active) return
  const options = { pageId: write.resourceId }
  return yield* write.action === WIKI_PAGE_ACTION.edit
    ? wikiError("update", "invalid", "Only active Memory pages can be updated", options)
    : wikiError(write.action, "invalid", "Only active Memory pages can be retired", options)
})

const requireWithinBoundary = Effect.fn("Wiki.requireWithinBoundary")(function* (
  { boundary }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  const paths = [write.path.before, write.path.after].filter((path) => path !== undefined)
  yield* requireWikiWritePaths(yield* boundary, "update", paths)
})

const requirePlacedNewPage = Effect.fn("Wiki.requirePlacedNewPage")(function* (
  { snapshot, boundary, spaceOwns }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  const path = write.path.after
  if (write.action !== WIKI_PAGE_ACTION.newPage || path === undefined) return
  yield* requireNewPagePlace(yield* snapshot, yield* boundary, spaceOwns, path)
})

const requireDirectoryEmptied = Effect.fn("Wiki.requireDirectoryEmptied")(function* (
  { snapshot, occupied }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  const path = write.path.before
  if (write.action !== WIKI_PAGE_ACTION.archive && write.action !== WIKI_PAGE_ACTION.merge) return
  if (path === undefined || !isReadme(path)) return
  const directory = posix.dirname(path)
  const after = yield* occupied
  const remapped = [...after].some(
    ([resourceId, other]) =>
      resourceId !== write.resourceId && isReadme(other) && posix.dirname(other) === directory
  )
  if (remapped) return
  const child = (yield* snapshot).wholeSet.find(
    (record) =>
      record.page.pageId !== write.resourceId &&
      record.page.lifecycle === WIKI_PAGE_LIFECYCLE.active &&
      after.get(record.page.pageId)?.startsWith(`${directory}/`) === true
  )
  if (child !== undefined)
    return yield* wikiError(write.action, "blocked", `Active Memory pages remain in ${directory}`, {
      pageId: write.resourceId
    })
})

const requireRedirectTargetKept = Effect.fn("Wiki.requireRedirectTargetKept")(function* (
  { snapshot }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  if (write.action !== WIKI_PAGE_ACTION.archive) return
  const pages = (yield* snapshot).wholeSet
  const broken = brokenRedirect(pages.filter((record) => record.page.pageId !== write.resourceId))
  if (broken !== undefined)
    return yield* wikiError(
      "archive",
      "invalid",
      `Page is still the target of redirect ${broken.page.pageId}`,
      { pageId: write.resourceId }
    )
})

const COMMIT_RULES: ReadonlyArray<{
  readonly binds: (origin: WikiCommitOrigin) => boolean
  readonly check: (view: CommitView, write: ResolvedWrite) => Effect.Effect<void, WikiCommitError>
}> = [
  { binds: () => true, check: requireNewPagePath },
  { binds: () => true, check: requireActivePage },
  { binds: () => true, check: requireWithinBoundary },
  { binds: () => true, check: requirePlacedNewPage },
  { binds: () => true, check: requireDirectoryEmptied },
  { binds: () => true, check: requireRedirectTargetKept },
  { binds: () => true, check: requireSpacePageKept },
  { binds: () => true, check: requireNameFree },
  { binds: (origin) => !isOwnerOrigin(origin), check: requireRedirectOnlyByMerge },
  { binds: () => true, check: (_view, write) => requireHumanAliases(write) },
  { binds: isUpkeep, check: requireNotRecord },
  { binds: () => true, check: requireNoMoveIntoRecords },
  { binds: isAutomatedOrigin, check: requireAutomatedRecordWrite },
  { binds: isAutomatedOrigin, check: requireAutomatedRetirement },
  { binds: (origin) => !isOutsideEdit(origin), check: refuseGrowthOverLimit },
  { binds: () => true, check: requireCodeOwnedPageKept },
  { binds: keepsForgottenLines, check: requireNoRetractedLine }
]

export const requireCommitRules = Effect.fn("Wiki.requireCommitRules")(function* (
  { repository, spaces }: WikiCommitPoint,
  { origin, authority }: WikiWriter,
  writes: ReadonlyArray<WikiWrite>
): Effect.fn.Return<void, WikiCommitError> {
  const resolved = yield* Effect.forEach(writes, (write) => resolveWrite(repository, write))
  const active = yield* Effect.cached(repository.listResources())
  const snapshot = yield* Effect.cached(loadSnapshot(repository, "update"))
  const view: CommitView = {
    repository,
    origin,
    folders: yield* Effect.cached(currentRecordFolders(repository, active)),
    occupied: yield* Effect.cached(
      active.pipe(Effect.map((list) => occupiedAfter(list, resolved)))
    ),
    guarded: yield* Effect.cached(openRetractions(repository).pipe(Effect.map(guardedLines))),
    spaceOwns: yield* spacePageCheck(spaces),
    snapshot,
    boundary: yield* Effect.cached(
      authority._tag === GLOBAL_WIKI_LOCATION_AUTHORITY._tag
        ? Effect.succeed(undefined)
        : snapshot.pipe(
            Effect.flatMap((pages) => resolveWikiWriteBoundary(spaces, authority, pages, "update"))
          )
    )
  }
  for (const rule of COMMIT_RULES) {
    if (!rule.binds(origin)) continue
    for (const write of resolved) yield* rule.check(view, write)
  }
})
