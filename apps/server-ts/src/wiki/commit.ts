import type {
  AdoptableWorkingChange,
  CommitInput,
  CommitResult,
  ManagedFileRepositoryShape,
  ResourceVersion,
  RevisionError
} from "@arden-hq/revisions/effect"
import { Effect, Option, Schema } from "effect"
import { posix } from "node:path"

import {
  corePageBudget,
  createRefusal,
  overPageLimit,
  pageLimitRefusal
} from "../memory/core-memory.js"
import type { SpaceStore, SpaceStoreError } from "../persistence/spaces/store.js"
import {
  requireNewPagePlace,
  requireWikiWritePaths,
  resolveWikiWriteBoundary,
  type WikiLocationAuthority,
  type WikiWriteBoundary
} from "./authority.js"
import { pageKind, producingAutomation, recordFolders, type RecordFolders } from "./collections.js"
import { wikiError, type WikiError } from "./errors.js"
import {
  aliasesAreHuman,
  formatRedirectPage,
  isReadme,
  namesTakenAt,
  parseWikiPage,
  takesName,
  type ParsedWikiPage
} from "./page.js"
import {
  guardedLines,
  openRetractions,
  putBack,
  retractionRefusal,
  type OpenRetraction
} from "./retraction.js"
import { brokenRedirect, loadSnapshot, type PageRecord, type Snapshot } from "./snapshot.js"
import { spacePageCheck } from "./space-index.js"
import { codeOwnedPage, isCodeOwnedPage } from "./code-owned-pages.js"

export type WikiCommitOrigin =
  /** The owner, in the app or in the file. */
  | { readonly kind: "user"; readonly via: "filesystem" | `desktop${string}` }
  /** The owner's own chat turn after their approval: forgetting or undoing a retraction, or
   *  changing their standing rules. */
  | { readonly kind: "forget" | "rules"; readonly sessionId: string }
  | {
      readonly kind: "agent"
      readonly sessionId: string | undefined
      readonly chainDepth?: number
    }
  | { readonly kind: "automation"; readonly automationId: string; readonly chainDepth?: number }
  | { readonly kind: "upkeep"; readonly automationId: string; readonly chainDepth?: number }
  | { readonly kind: "capture"; readonly sessionId: string | undefined }
  | { readonly kind: "space_page" }
  | { readonly kind: "system"; readonly name: string }

export type WikiCommitSource = "user" | "agent" | "automation" | "system"

export interface WikiCommitIdentity {
  readonly actor: string
  readonly origin: WikiCommitOrigin
  readonly reason: string
  /** Names a write that may be sent again after a crash; the same write lands once. */
  readonly replayKey?: string
}

/** Who writes, and where in Memory they may write. */
export interface WikiWriter {
  readonly origin: WikiCommitOrigin
  readonly authority: WikiLocationAuthority
}

/** Wiki Maintenance, the upkeep Automation; the system handler registry decides which Automation that is. */
export const upkeepOrigin = (
  automationId: string,
  chainDepth?: number
): Extract<WikiCommitOrigin, { readonly kind: "upkeep" }> => ({
  kind: "upkeep",
  automationId,
  ...(chainDepth === undefined ? {} : { chainDepth })
})

export const automationOrigin = (
  automationId: string,
  chainDepth?: number
): Extract<WikiCommitOrigin, { readonly kind: "automation" }> => ({
  kind: "automation",
  automationId,
  ...(chainDepth === undefined ? {} : { chainDepth })
})

/** The owner, changing Memory in the app. */
export const ownerInApp = (
  reason: string,
  via: `desktop${string}` = "desktop"
): WikiCommitIdentity => ({ actor: "user:desktop", origin: { kind: "user", via }, reason })

const AUTOMATION_PREFIX = "wiki.automation."
const UPKEEP_PREFIX = "wiki.upkeep."
const RETIRED_UPKEEP_ORIGINS: ReadonlyMap<string, string> = new Map([
  ["wiki.maintenance", "builtin-wiki-maintenance"],
  ["wiki.automation.builtin-wiki-maintenance", "builtin-wiki-maintenance"]
])
const CHAIN_MARK = "~"
const AGENT_ORIGIN = "wiki.agent"
const CAPTURE_ORIGIN = "memory.capture"
const OWNER_TURN_ORIGINS = { forget: "memory.forget", rules: "memory.rules" } as const
const CHAINED = /^(.+)~(\d+)$/u

const chainMark = (chainDepth: number | undefined): string =>
  chainDepth === undefined || chainDepth === 0 ? "" : `${CHAIN_MARK}${chainDepth}`

const withChat = (base: string, sessionId: string | undefined): string =>
  sessionId === undefined ? base : `${base}@${sessionId}`

const chatOf = (origin: string, base: string): string | undefined | null => {
  if (origin === base) return undefined
  return origin.startsWith(`${base}@`) && origin.length > base.length + 1
    ? origin.slice(base.length + 1)
    : null
}

const encodeWikiOrigin = (origin: WikiCommitOrigin): string => {
  switch (origin.kind) {
    case "user":
      return origin.via
    case "agent":
      return `${withChat(AGENT_ORIGIN, origin.sessionId)}${chainMark(origin.chainDepth)}`
    case "automation":
    case "upkeep":
      return `${origin.kind === "upkeep" ? UPKEEP_PREFIX : AUTOMATION_PREFIX}${origin.automationId}${chainMark(origin.chainDepth)}`
    case "capture":
      return withChat(CAPTURE_ORIGIN, origin.sessionId)
    case "forget":
    case "rules":
      return withChat(OWNER_TURN_ORIGINS[origin.kind], origin.sessionId)
    case "space_page":
      return "space.page"
    case "system":
      return origin.name
  }
}

const isDesktopOrigin = (origin: string): origin is `desktop${string}` =>
  origin.startsWith("desktop")

export const decodeWikiOrigin = (origin: string): WikiCommitOrigin => {
  if (origin === "filesystem" || isDesktopOrigin(origin)) return { kind: "user", via: origin }
  const agentChained = CHAINED.exec(origin)
  const agentChat = chatOf(agentChained?.[1] ?? origin, AGENT_ORIGIN)
  if (agentChat !== null)
    return {
      kind: "agent",
      sessionId: agentChat,
      ...(agentChained?.[2] === undefined ? {} : { chainDepth: Number(agentChained[2]) })
    }
  const captureChat = chatOf(origin, CAPTURE_ORIGIN)
  if (captureChat !== null) return { kind: "capture", sessionId: captureChat }
  for (const kind of ["forget", "rules"] as const) {
    const ownerChat = chatOf(origin, OWNER_TURN_ORIGINS[kind])
    if (ownerChat !== null && ownerChat !== undefined) return { kind, sessionId: ownerChat }
  }
  if (origin === "space.page") return { kind: "space_page" }
  const prefix = [UPKEEP_PREFIX, AUTOMATION_PREFIX].find((each) => origin.startsWith(each))
  const named = prefix === undefined ? "" : origin.slice(prefix.length).trim()
  const chained = CHAINED.exec(named)
  const automationId = chained?.[1] ?? named
  const retired = RETIRED_UPKEEP_ORIGINS.get(
    automationId === "" ? origin : `${prefix ?? ""}${automationId}`
  )
  if (automationId === "" && retired === undefined) return { kind: "system", name: origin }
  const chainDepth = chained?.[2] === undefined ? undefined : Number(chained[2])
  return prefix === UPKEEP_PREFIX || retired !== undefined
    ? upkeepOrigin(retired ?? automationId, chainDepth)
    : automationOrigin(automationId, chainDepth)
}

export const wikiOriginSource = (origin: WikiCommitOrigin): WikiCommitSource => {
  switch (origin.kind) {
    case "user":
    case "agent":
    case "automation":
      return origin.kind
    case "forget":
    case "rules":
      return "user"
    case "capture":
    case "upkeep":
      return "automation"
    case "space_page":
    case "system":
      return "system"
  }
}

export const wikiOriginChat = (origin: WikiCommitOrigin): string | undefined => {
  switch (origin.kind) {
    case "agent":
    case "capture":
    case "forget":
    case "rules":
      return origin.sessionId
    case "user":
    case "automation":
    case "upkeep":
    case "space_page":
    case "system":
      return undefined
  }
}

const isAutomatedOrigin = (origin: WikiCommitOrigin): boolean =>
  wikiOriginSource(origin) === "automation"

const isOwnerOrigin = (origin: WikiCommitOrigin): boolean =>
  origin.kind === "user" || origin.kind === "forget" || origin.kind === "rules"

const isCaptureWriter = (origin: WikiCommitOrigin): boolean => origin.kind === "capture"

const isSpacePageWriter = (origin: WikiCommitOrigin): boolean => origin.kind === "space_page"

type WikiPageOperation = CommitInput["operations"][number]

type Operation<Tag extends WikiPageOperation["_tag"]> = Extract<
  WikiPageOperation,
  { readonly _tag: Tag }
>

export type WikiWrite =
  | { readonly action: "create" | "new_page"; readonly operation: Operation<"Create"> }
  | { readonly action: "publish"; readonly operation: Operation<"Create" | "Update"> }
  | {
      readonly action: "edit" | "restore_version" | "merge"
      readonly operation: Operation<"Update">
    }
  | { readonly action: "move"; readonly operation: Operation<"Move"> }
  | { readonly action: "archive"; readonly operation: Operation<"Archive"> }
  | { readonly action: "restore_archived"; readonly operation: Operation<"Restore"> }

type WikiPageAction = WikiWrite["action"]

type PageVersion = Pick<ResourceVersion, "resourceId" | "versionId">

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const created = (resourceId: string, path: string, content: string): Operation<"Create"> => ({
  _tag: "Create",
  resourceId,
  path,
  content: encoder.encode(content)
})

const updated = (page: PageVersion, content: string): Operation<"Update"> => ({
  _tag: "Update",
  resourceId: page.resourceId,
  expectedVersion: page.versionId,
  content: encoder.encode(content)
})

export const createPage = (resourceId: string, path: string, content: string): WikiWrite => ({
  action: "create",
  operation: created(resourceId, path, content)
})

/** A page a writer asks for by path, as against one Arden places itself. */
export const newPage = (resourceId: string, path: string, content: string): WikiWrite => ({
  action: "new_page",
  operation: created(resourceId, path, content)
})

export const updatePage = (page: PageVersion, content: string): WikiWrite => ({
  action: "edit",
  operation: updated(page, content)
})

/** A report its producing Automation publishes: its first version or a new one. */
export const publishReport = (
  page: PageVersion | { readonly resourceId: string; readonly path: string },
  content: string
): WikiWrite => ({
  action: "publish",
  operation:
    "versionId" in page ? updated(page, content) : created(page.resourceId, page.path, content)
})

/** An earlier version's content, written as the page's next version. */
export const restoreVersion = (page: PageVersion, content: string): WikiWrite => ({
  action: "restore_version",
  operation: updated(page, content)
})

/** The page replaced by a redirect to `redirectTo`; restoring an earlier version undoes it. */
export const mergePage = (
  page: PageVersion,
  redirect: { readonly pageId: string; readonly title: string; readonly redirectTo: string }
): WikiWrite => ({
  action: "merge",
  operation: updated(page, formatRedirectPage(redirect))
})

export const movePage = (page: PageVersion, path: string, content?: string): WikiWrite => ({
  action: "move",
  operation: {
    _tag: "Move",
    resourceId: page.resourceId,
    expectedVersion: page.versionId,
    path,
    ...(content === undefined ? {} : { content: encoder.encode(content) })
  }
})

export const archivePage = (page: PageVersion): WikiWrite => ({
  action: "archive",
  operation: { _tag: "Archive", resourceId: page.resourceId, expectedVersion: page.versionId }
})

export const restoreArchivedPage = (page: PageVersion): WikiWrite => ({
  action: "restore_archived",
  operation: { _tag: "Restore", resourceId: page.resourceId, expectedVersion: page.versionId }
})

class WikiCommitRuleError extends Schema.TaggedError<WikiCommitRuleError>()("WikiCommitRuleError", {
  rule: Schema.Literals([
    "aliases",
    "size",
    "records",
    "retire",
    "code_owned",
    "retraction",
    "space",
    "names"
  ] as const),
  message: Schema.String
}) {}

export type WikiCommitError = RevisionError | SpaceStoreError | WikiCommitRuleError | WikiError

export interface WikiCommitPoint {
  readonly repository: ManagedFileRepositoryShape
  readonly spaces: Pick<SpaceStore["Service"], "activeBindings" | "get">
}

export const commitWiki = (
  point: WikiCommitPoint,
  options: WikiCommitIdentity & WikiWriter & { readonly expectedRevision: string | null },
  writes: ReadonlyArray<WikiWrite>
): Effect.Effect<CommitResult, WikiCommitError> => {
  const { replayKey } = options
  const commit = point.repository.commit({
    actor: options.actor,
    origin: encodeWikiOrigin(options.origin),
    reason: options.reason,
    operations: writes.map((write) => write.operation),
    ...(options.expectedRevision === null
      ? { expectedHead: null, enforceExpectedHead: true }
      : { expectedHead: options.expectedRevision }),
    ...(replayKey === undefined ? {} : { idempotencyKey: replayKey })
  })
  const checked = requireCommitRules(point, options, writes).pipe(Effect.andThen(commit))
  return replayKey === undefined
    ? checked
    : replayOrCommit(point.repository, replayKey, { checked, landed: commit })
}

const replayOrCommit = (
  repository: ManagedFileRepositoryShape,
  replayKey: string,
  write: {
    readonly checked: Effect.Effect<CommitResult, WikiCommitError>
    readonly landed: Effect.Effect<CommitResult, WikiCommitError>
  }
): Effect.Effect<CommitResult, WikiCommitError> =>
  repository
    .idempotencyReceipt(replayKey)
    .pipe(Effect.flatMap((receipt) => (receipt === null ? write.checked : write.landed)))

/**
 * Record one change made outside Arden that is already in the page's file. It meets the commit
 * rules that bind an outside edit, and is guarded by the head the caller decided on.
 */
export const commitOutsideChange = (
  point: WikiCommitPoint,
  options: WikiCommitIdentity & WikiWriter & { readonly expectedRevision: string | null },
  change: AdoptableWorkingChange
): Effect.Effect<CommitResult, WikiCommitError> =>
  requireCommitRules(point, options, [
    change.kind === "changed"
      ? {
          action: "edit",
          operation: {
            _tag: "Update",
            resourceId: change.resource.resourceId,
            expectedVersion: change.resource.versionId,
            content: change.content
          }
        }
      : archivePage(change.resource)
  ]).pipe(
    Effect.andThen(
      point.repository.adoptWorkingChange(change, {
        actor: options.actor,
        origin: encodeWikiOrigin(options.origin),
        reason: options.reason,
        expectedHead: options.expectedRevision
      })
    )
  )

interface ResolvedWrite {
  readonly action: WikiPageAction
  readonly resourceId: string
  readonly before: ResourceVersion | null
  readonly path: { readonly before: string | undefined; readonly after: string | undefined }
  readonly given: Uint8Array | undefined
  /** The page `given` reads as, if it reads as one. */
  readonly page: Option.Option<ParsedWikiPage>
  readonly beforeContent: Effect.Effect<Uint8Array | null, RevisionError>
  readonly pageBefore: Effect.Effect<Option.Option<ParsedWikiPage>, RevisionError>
}

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
  const before = operation._tag === "Create" ? null : yield* repository.get(operation.resourceId)
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
      after: operation._tag === "Archive" ? undefined : (moved ?? before?.path)
    },
    given,
    page: yield* readPage(given),
    beforeContent,
    pageBefore: yield* Effect.cached(beforeContent.pipe(Effect.flatMap(readPage)))
  }
})

interface CommitView {
  readonly repository: ManagedFileRepositoryShape
  readonly origin: WikiCommitOrigin
  readonly folders: Effect.Effect<RecordFolders, RevisionError>
  readonly occupied: Effect.Effect<ReadonlyMap<string, string>, RevisionError>
  readonly guarded: Effect.Effect<ReadonlyMap<string, OpenRetraction>, RevisionError>
  readonly spaceOwns: (pageId: string, path: string) => Effect.Effect<boolean, SpaceStoreError>
  readonly snapshot: Effect.Effect<Snapshot, WikiError>
  readonly boundary: Effect.Effect<WikiWriteBoundary | undefined, WikiError>
}

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
    write.before?.state === "active"
      ? overAt(write.before.path, yield* write.pageBefore)
      : undefined
  if (was !== undefined && over.chars <= was.chars) return
  return yield* ruleError("size", pageLimitRefusal(isOwnerOrigin(origin), path, over))
})

const isOutsideEdit = (origin: WikiCommitOrigin): boolean =>
  origin.kind === "user" && origin.via === "filesystem"

const isUpkeep = (origin: WikiCommitOrigin): boolean => origin.kind === "upkeep"

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

const ruleError = (rule: WikiCommitRuleError["rule"], message: string) =>
  new WikiCommitRuleError({ rule, message })

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
  if (write.before?.state === "active" && write.path.before === path) return
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
    if (kind.kind === "knowledge") continue
    return yield* ruleError(
      "records",
      `${path} is ${kind.kind === "record" ? "a record" : "the contract"} of ${kind.folder.directory}/, kept as its producer wrote it. ` +
        "Wiki Maintenance reads it but does not change it. Nothing was saved. Put what it says on a subject page instead."
    )
  }
})

const requireNoMoveIntoRecords = Effect.fn("Wiki.requireNoMoveIntoRecords")(function* (
  { folders }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  if (write.action !== "move" || write.path.after === undefined) return
  const producer = producingAutomation(yield* folders, write.path.after)
  if (producer === undefined) return
  return yield* ruleError(
    "records",
    `${write.path.after} is in the record folder of Automation ${producer}, which only it fills, by publishing reports. Nothing was moved.`
  )
})

const isProducer = (origin: WikiCommitOrigin, producer: string): boolean =>
  origin.kind === "automation" && origin.automationId === producer

const requireAutomatedRecordWrite = Effect.fn("Wiki.requireAutomatedRecordWrite")(function* (
  { origin, folders }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  switch (write.action) {
    case "edit":
    case "restore_version":
    case "restore_archived":
      return
    case "create":
    case "new_page":
    case "publish": {
      if (write.before !== null || write.path.after === undefined) return
      const producer = producingAutomation(yield* folders, write.path.after)
      if (producer === undefined || (write.action === "publish" && isProducer(origin, producer)))
        return
      return yield* ruleError(
        "records",
        `${write.path.after} is in the record folder of Automation ${producer}; only that Automation adds pages to it, by publishing reports. Nothing was saved.`
      )
    }
    case "move":
    case "archive":
    case "merge": {
      if (write.path.before === undefined) return
      const producer = producingAutomation(yield* folders, write.path.before)
      if (producer === undefined) return
      return yield* ruleError(
        "records",
        `${write.path.before} belongs to the record folder of Automation ${producer}. An Automation run does not move, archive or merge away its pages. Nothing was saved.`
      )
    }
  }
})

const requireAutomatedRetirement = Effect.fn("Wiki.requireAutomatedRetirement")(function* (
  { repository }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  if (write.action !== "archive" && write.action !== "merge") return
  const path = write.path.before
  if (path === undefined) return
  if (posix.dirname(path) === ".") {
    return yield* ruleError(
      "retire",
      `${path} is at the Memory root. An Automation run does not archive or merge it. Nothing was saved.`
    )
  }
  if (write.action === "merge" && (yield* wasUnmerged(repository, write.resourceId)))
    return yield* ruleError(
      "retire",
      `${path} was merged before and then restored, so it stays its own page. Leave it.`
    )
})

const wasUnmerged = Effect.fn("Wiki.wasUnmerged")(function* (
  repository: ManagedFileRepositoryShape,
  resourceId: string
): Effect.fn.Return<boolean, RevisionError> {
  for (const commit of yield* repository.history({ resourceId, limit: null })) {
    const version = commit.changes.find(
      (change) => (change.after ?? change.before)?.resourceId === resourceId
    )?.after
    if (version === undefined || version === null || version.state !== "active") continue
    const earlier = yield* parseWikiPage(
      decoder.decode(yield* repository.readVersion(version))
    ).pipe(Effect.option)
    if (Option.isSome(earlier) && earlier.value.lifecycle === "redirect") return true
  }
  return false
})

const requireSpacePageKept = Effect.fn("Wiki.requireSpacePageKept")(function* (
  { origin, spaceOwns }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  const path = write.path.before
  if (path === undefined) return
  const retires = write.action === "merge" || write.path.after !== path
  if (!retires && !(write.action === "restore_version" && isCaptureWriter(origin))) return
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
  if (write.before === null || write.action === "merge") return
  if (Option.isNone(page) || page.value.lifecycle !== "redirect") return
  return yield* ruleError(
    "retire",
    `${write.before.path} would become a redirect, which only a merge makes. Nothing was saved.`
  )
})

const keepsCodeOwnedPage = (origin: WikiCommitOrigin, write: ResolvedWrite): boolean => {
  switch (write.action) {
    case "create":
    case "new_page":
    case "publish":
      if (write.before === null)
        return codeOwnedPage(write.path.after ?? "")?.madeBy === origin.kind
      break
    case "archive":
      return false
    case "move":
      if (write.path.after !== write.path.before) return false
      break
    case "edit":
    case "restore_version":
    case "merge":
    case "restore_archived":
      break
  }
  return Option.isNone(write.page) || write.page.value.lifecycle === "active"
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
    write.given ?? (write.action === "restore_archived" ? yield* write.beforeContent : null)
  if (isCodeOwnedPage(path) || source === null) return
  const after = yield* pageBody(source)
  const kept = write.before?.state === "active"
  const had = kept ? yield* pageBody((yield* write.beforeContent) ?? new Uint8Array()) : undefined
  const entry = putBack(lines, had, after)
  if (entry !== undefined) return yield* ruleError("retraction", retractionRefusal(path, entry))
})

const requireNewPagePath = (_view: CommitView, write: ResolvedWrite) => {
  const path = write.action === "new_page" ? write.path.after : undefined
  const refused = path === undefined ? undefined : createRefusal(path)
  return refused === undefined ? Effect.void : wikiError("create", refused.code, refused.message)
}

const requireActivePage = Effect.fn("Wiki.requireActivePage")(function* (
  _view: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  if (write.action !== "edit" && write.action !== "archive" && write.action !== "merge") return
  const page = yield* write.pageBefore
  if (Option.isNone(page) || page.value.lifecycle === "active") return
  const options = { pageId: write.resourceId }
  return yield* write.action === "edit"
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
  if (write.action !== "new_page" || path === undefined) return
  yield* requireNewPagePlace(yield* snapshot, yield* boundary, spaceOwns, path)
})

const requireDirectoryEmptied = Effect.fn("Wiki.requireDirectoryEmptied")(function* (
  { snapshot, occupied }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  const path = write.path.before
  if (write.action !== "archive" && write.action !== "merge") return
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
      record.page.lifecycle === "active" &&
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
  if (write.action !== "archive") return
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

/** Fails with the first rule that refuses one of `writes` for this writer. */
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
      authority._tag === "Global"
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
