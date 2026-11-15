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

import { CORE_CONDENSE_ADVICE, coreCondenseTarget, corePageBudget } from "../memory/core-memory.js"
import { pageKind, producingAutomation, recordFolders, type RecordFolders } from "./collections.js"
import { aliasesAreHuman, isReadme, parseWikiPage } from "./page.js"
import {
  guardedLines,
  openRetractions,
  putBack,
  retractionRefusal,
  type OpenRetraction
} from "./retraction.js"
import type { PageRecord } from "./snapshot.js"
import { isSystemPage } from "./system-pages.js"

export type WikiCommitOrigin =
  /** The owner, in the app or in the file. */
  | { readonly kind: "user"; readonly via: "filesystem" | `desktop${string}` }
  /** The owner's own chat turn, forgetting or undoing a retraction after their approval. */
  | { readonly kind: "forget"; readonly sessionId: string }
  | { readonly kind: "agent"; readonly sessionId: string | undefined }
  | { readonly kind: "automation"; readonly automationId: string; readonly chainDepth?: number }
  /** Wiki Maintenance. History records it as its Automation, so a decoded origin is never this. */
  | { readonly kind: "upkeep"; readonly automationId: string; readonly chainDepth?: number }
  | {
      readonly kind: "capture"
      readonly replayKey: string | undefined
      readonly sessionId: string | undefined
    }
  | { readonly kind: "space_page" }
  | { readonly kind: "system"; readonly name: string }

export type WikiCommitSource = "user" | "agent" | "automation" | "system"

export interface WikiCommitIdentity {
  readonly actor: string
  readonly origin: WikiCommitOrigin
  readonly reason: string
}

/** The owner, changing Memory in the app. */
export const ownerInApp = (
  reason: string,
  via: `desktop${string}` = "desktop"
): WikiCommitIdentity => ({ actor: "user:desktop", origin: { kind: "user", via }, reason })

export const LEGACY_MAINTENANCE_ORIGIN = "wiki.maintenance"

const AUTOMATION_PREFIX = "wiki.automation."
const CHAIN_MARK = "~"
const AGENT_ORIGIN = "wiki.agent"
const CAPTURE_ORIGIN = "memory.capture"
const FORGET_ORIGIN = "memory.forget"

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
      return withChat(AGENT_ORIGIN, origin.sessionId)
    case "automation":
    case "upkeep":
      return `${AUTOMATION_PREFIX}${origin.automationId}${
        origin.chainDepth === undefined || origin.chainDepth === 0
          ? ""
          : `${CHAIN_MARK}${origin.chainDepth}`
      }`
    case "capture":
      return withChat(CAPTURE_ORIGIN, origin.sessionId)
    case "forget":
      return withChat(FORGET_ORIGIN, origin.sessionId)
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
  const agentChat = chatOf(origin, AGENT_ORIGIN)
  if (agentChat !== null) return { kind: "agent", sessionId: agentChat }
  const captureChat = chatOf(origin, CAPTURE_ORIGIN)
  if (captureChat !== null) return { kind: "capture", replayKey: undefined, sessionId: captureChat }
  const forgetChat = chatOf(origin, FORGET_ORIGIN)
  if (forgetChat !== null && forgetChat !== undefined)
    return { kind: "forget", sessionId: forgetChat }
  if (origin === "space.page") return { kind: "space_page" }
  const named = origin.startsWith(AUTOMATION_PREFIX)
    ? origin.slice(AUTOMATION_PREFIX.length).trim()
    : ""
  const chained = /^(.+)~(\d+)$/u.exec(named)
  const automationId = chained?.[1] ?? named
  if (automationId === "") return { kind: "system", name: origin }
  return chained?.[2] === undefined
    ? { kind: "automation", automationId }
    : { kind: "automation", automationId, chainDepth: Number(chained[2]) }
}

export const wikiOriginSource = (origin: WikiCommitOrigin): WikiCommitSource => {
  switch (origin.kind) {
    case "user":
    case "agent":
    case "automation":
      return origin.kind
    case "forget":
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

/** Whether the owner made this write: no rule about what the owner may write binds it. */
const isOwnerOrigin = (origin: WikiCommitOrigin): boolean =>
  origin.kind === "user" || origin.kind === "forget"

export type WikiPageOperation = CommitInput["operations"][number]

type PageVersion = Pick<ResourceVersion, "resourceId" | "versionId">

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const createPage = (
  resourceId: string,
  path: string,
  content: string
): WikiPageOperation => ({
  _tag: "Create",
  resourceId,
  path,
  content: encoder.encode(content)
})

export const updatePage = (page: PageVersion, content: string): WikiPageOperation => ({
  _tag: "Update",
  resourceId: page.resourceId,
  expectedVersion: page.versionId,
  content: encoder.encode(content)
})

export const movePage = (page: PageVersion, path: string, content?: string): WikiPageOperation => ({
  _tag: "Move",
  resourceId: page.resourceId,
  expectedVersion: page.versionId,
  path,
  ...(content === undefined ? {} : { content: encoder.encode(content) })
})

export const archivePage = (page: PageVersion): WikiPageOperation => ({
  _tag: "Archive",
  resourceId: page.resourceId,
  expectedVersion: page.versionId
})

export const restorePage = (page: PageVersion): WikiPageOperation => ({
  _tag: "Restore",
  resourceId: page.resourceId,
  expectedVersion: page.versionId
})

class WikiCommitRuleError extends Schema.TaggedError<WikiCommitRuleError>()("WikiCommitRuleError", {
  rule: Schema.Literals(["aliases", "size", "records", "retire", "code_owned", "retraction"] as const),
  message: Schema.String
}) {}

export type WikiCommitError = RevisionError | WikiCommitRuleError

export const commitWiki = (
  repository: ManagedFileRepositoryShape,
  options: WikiCommitIdentity & {
    readonly expectedRevision: string | null
    readonly idempotencyKey?: string
  },
  operations: ReadonlyArray<WikiPageOperation>
): Effect.Effect<CommitResult, WikiCommitError> => {
  const replayKey =
    options.idempotencyKey ??
    (options.origin.kind === "capture" ? options.origin.replayKey : undefined)
  const commit = repository.commit({
    actor: options.actor,
    origin: encodeWikiOrigin(options.origin),
    reason: options.reason,
    operations,
    ...(options.expectedRevision === null
      ? { expectedHead: null, enforceExpectedHead: true }
      : { expectedHead: options.expectedRevision }),
    ...(replayKey === undefined ? {} : { idempotencyKey: replayKey })
  })
  const checked = requireCommitRules(repository, options.origin, operations).pipe(
    Effect.andThen(commit)
  )
  return replayKey === undefined
    ? checked
    : replayOrCommit(repository, replayKey, { checked, landed: commit })
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
  repository: ManagedFileRepositoryShape,
  options: WikiCommitIdentity & { readonly expectedRevision: string | null },
  change: AdoptableWorkingChange
): Effect.Effect<CommitResult, WikiCommitError> =>
  requireCommitRules(repository, options.origin, [
    change.kind === "changed"
      ? {
          _tag: "Update",
          resourceId: change.resource.resourceId,
          expectedVersion: change.resource.versionId,
          content: change.content
        }
      : archivePage(change.resource)
  ]).pipe(
    Effect.andThen(
      repository.adoptWorkingChange(change, {
        actor: options.actor,
        origin: encodeWikiOrigin(options.origin),
        reason: options.reason,
        expectedHead: options.expectedRevision
      })
    )
  )

const requireHumanAliases = (
  operation: WikiPageOperation
): Effect.Effect<void, WikiCommitRuleError> => {
  const content = "content" in operation ? operation.content : undefined
  if (content === undefined) return Effect.void
  return parseWikiPage(decoder.decode(content)).pipe(
    Effect.option,
    Effect.flatMap((page) =>
      Option.isNone(page) || aliasesAreHuman(page.value.title, page.value.aliases)
        ? Effect.void
        : Effect.fail(
            new WikiCommitRuleError({
              rule: "aliases",
              message: `Wiki page ${operation.resourceId} keeps a path or a repeated name as an alias`
            })
          )
    )
  )
}

/** How far a page body is over its limit, or undefined when it fits or has none. */
export const overPageLimit = (page: {
  readonly path: string
  readonly pageId: string
  readonly body: string
}): { readonly chars: number; readonly limit: number } | undefined => {
  const limit = corePageBudget(page)
  return limit === undefined || page.body.length <= limit
    ? undefined
    : { chars: page.body.length, limit }
}

const limitRefusal = (
  origin: WikiCommitOrigin,
  path: string,
  over: { readonly chars: number; readonly limit: number }
): WikiCommitRuleError => {
  const target = coreCondenseTarget(over.limit)
  return new WikiCommitRuleError({
    rule: "size",
    message: isOwnerOrigin(origin)
      ? `${path} would have ${over.chars} characters; its limit is ${over.limit}, because it is sent whole to every chat. ` +
        `Nothing was saved. Shorten it by at least ${over.chars - over.limit} characters.`
      : `${path} would have ${over.chars} characters, but it is sent whole to every run and is limited to ${over.limit}. ` +
        `Nothing was saved. Cut at least ${over.chars - over.limit} characters; aim for ${target} or fewer ` +
        `(${over.chars - target} less) so later updates fit. Trimming a few words will not do it. ` +
        `${CORE_CONDENSE_ADVICE} Then retry with the new fact included.`
  })
}

const refuseGrowthOverLimit = Effect.fn("Wiki.refuseGrowthOverLimit")(function* (
  { repository, origin }: CommitView,
  operation: WikiPageOperation
): Effect.fn.Return<void, WikiCommitError> {
  if (operation._tag === "Archive") return
  const before = operation._tag === "Create" ? null : yield* repository.get(operation.resourceId)
  const path = ("path" in operation ? operation.path : undefined) ?? before?.path
  if (path === undefined) return
  const given = "content" in operation ? operation.content : undefined
  const over = yield* bodyOverLimit(repository, path, operation.resourceId, given ?? before)
  if (over === undefined) return
  const was =
    before?.state === "active"
      ? yield* bodyOverLimit(repository, before.path, operation.resourceId, before)
      : undefined
  if (was !== undefined && over.chars <= was.chars) return
  return yield* limitRefusal(origin, path, over)
})

const bodyOverLimit = Effect.fn("Wiki.bodyOverLimit")(function* (
  repository: ManagedFileRepositoryShape,
  path: string,
  pageId: string,
  content: Uint8Array | ResourceVersion | null
): Effect.fn.Return<{ readonly chars: number; readonly limit: number } | undefined, RevisionError> {
  if (content === null || corePageBudget({ path, pageId }) === undefined) return undefined
  const bytes = content instanceof Uint8Array ? content : yield* repository.readVersion(content)
  const page = yield* parseWikiPage(decoder.decode(bytes)).pipe(Effect.option)
  return Option.isNone(page) ? undefined : overPageLimit({ path, pageId, body: page.value.body })
})

const isOutsideEdit = (origin: WikiCommitOrigin): boolean =>
  origin.kind === "user" && origin.via === "filesystem"

const isUpkeep = (origin: WikiCommitOrigin): boolean => origin.kind === "upkeep"

/** The record folders at the head a commit is checked against, from the README pages alone. */
const currentRecordFolders = Effect.fn("Wiki.currentRecordFolders")(function* (
  repository: ManagedFileRepositoryShape
): Effect.fn.Return<RecordFolders, RevisionError> {
  const readmes = (yield* repository.listResources()).filter((resource) => isReadme(resource.path))
  const pages = yield* Effect.forEach(readmes, (resource) =>
    repository.readVersion(resource).pipe(
      Effect.flatMap((bytes) => parseWikiPage(decoder.decode(bytes)).pipe(Effect.option)),
      Effect.map((page): ReadonlyArray<PageRecord> =>
        Option.isNone(page) ? [] : [{ resource, page: page.value }]
      )
    )
  )
  return recordFolders(pages.flat())
})

const ruleError = (rule: WikiCommitRuleError["rule"], message: string) =>
  new WikiCommitRuleError({ rule, message })

/** The page's path before this operation, or undefined for a page it creates. */
const pathBefore = Effect.fn("Wiki.pathBefore")(function* (
  repository: ManagedFileRepositoryShape,
  operation: WikiPageOperation
): Effect.fn.Return<string | undefined, RevisionError> {
  if (operation._tag === "Create") return undefined
  return (yield* repository.get(operation.resourceId))?.path
})

const writesRedirect = (operation: WikiPageOperation): Effect.Effect<boolean> =>
  operation._tag === "Update"
    ? parseWikiPage(decoder.decode(operation.content)).pipe(
        Effect.map((page) => page.lifecycle === "redirect"),
        Effect.orElseSucceed(() => false)
      )
    : Effect.succeed(false)

const requireNotRecord = Effect.fn("Wiki.requireNotRecord")(function* (
  { repository, folders }: CommitView,
  operation: WikiPageOperation
): Effect.fn.Return<void, WikiCommitError> {
  const paths = [
    yield* pathBefore(repository, operation),
    "path" in operation ? operation.path : undefined
  ]
  for (const path of paths) {
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
  operation: WikiPageOperation
): Effect.fn.Return<void, WikiCommitError> {
  if (operation._tag !== "Move") return
  const producer = producingAutomation(yield* folders, operation.path)
  if (producer === undefined) return
  return yield* ruleError(
    "records",
    `${operation.path} is in the record folder of Automation ${producer}, which only it fills, by publishing reports. Nothing was moved.`
  )
})

/**
 * What an automated writer may do to an Automation's record folder: add a page only as its
 * producer, update a page, and never move, archive or merge one away.
 */
const requireAutomatedRecordWrite = Effect.fn("Wiki.requireAutomatedRecordWrite")(function* (
  { repository, origin, folders }: CommitView,
  operation: WikiPageOperation
): Effect.fn.Return<void, WikiCommitError> {
  if (operation._tag === "Restore") return
  if (operation._tag === "Create") {
    const producer = producingAutomation(yield* folders, operation.path)
    if (
      producer === undefined ||
      (origin.kind === "automation" && origin.automationId === producer)
    )
      return
    return yield* ruleError(
      "records",
      `${operation.path} is in the record folder of Automation ${producer}; only that Automation adds pages to it, by publishing reports. Nothing was saved.`
    )
  }
  if (operation._tag === "Update" && !(yield* writesRedirect(operation))) return
  const path = yield* pathBefore(repository, operation)
  if (path === undefined) return
  const producer = producingAutomation(yield* folders, path)
  if (producer === undefined) return
  return yield* ruleError(
    "records",
    `${path} belongs to the record folder of Automation ${producer}. An Automation run does not move, archive or merge away its pages. Nothing was saved.`
  )
})

/**
 * What an automated writer may not retire: a page at the Memory root, or a page that was merged
 * and then brought back, which is separate by someone's decision that a repeated merge would undo.
 */
const requireAutomatedRetirement = Effect.fn("Wiki.requireAutomatedRetirement")(function* (
  { repository }: CommitView,
  operation: WikiPageOperation
): Effect.fn.Return<void, WikiCommitError> {
  const merge = yield* writesRedirect(operation)
  if (operation._tag !== "Archive" && !merge) return
  const path = yield* pathBefore(repository, operation)
  if (path === undefined) return
  if (posix.dirname(path) === ".") {
    return yield* ruleError(
      "retire",
      `${path} is at the Memory root. An Automation run does not archive or merge it. Nothing was saved.`
    )
  }
  if (!merge) return
  for (const commit of yield* repository.history({
    resourceId: operation.resourceId,
    limit: null
  })) {
    const version = commit.changes.find(
      (change) => (change.after ?? change.before)?.resourceId === operation.resourceId
    )?.after
    if (version === undefined || version === null || version.state !== "active") continue
    const earlier = yield* parseWikiPage(
      decoder.decode(yield* repository.readVersion(version))
    ).pipe(Effect.option)
    if (Option.isSome(earlier) && earlier.value.lifecycle === "redirect") {
      return yield* ruleError(
        "retire",
        `${path} was merged before and then restored, so it stays its own page. Leave it.`
      )
    }
  }
})

/** Whether `operation` keeps a code-owned page where code finds it: active, at its path. */
const keepsSystemPage = Effect.fn("Wiki.keepsSystemPage")(function* (
  origin: WikiCommitOrigin,
  operation: WikiPageOperation,
  before: ResourceVersion | null
): Effect.fn.Return<boolean> {
  switch (operation._tag) {
    case "Create":
      return origin.kind === "forget"
    case "Archive":
      return false
    case "Update":
    case "Move":
    case "Restore": {
      const path = "path" in operation ? operation.path : undefined
      if (path !== undefined && path !== before?.path) return false
      const content = "content" in operation ? operation.content : undefined
      if (content === undefined) return true
      const page = yield* parseWikiPage(decoder.decode(content)).pipe(Effect.option)
      return Option.isNone(page) || page.value.lifecycle === "active"
    }
  }
})

interface CommitView {
  readonly repository: ManagedFileRepositoryShape
  readonly origin: WikiCommitOrigin
  /** Read once per commit, and only by a rule that needs it. */
  readonly folders: Effect.Effect<RecordFolders, RevisionError>
  /** The lines the owner asked to forget; read once per commit, and only by a rule that needs them. */
  readonly guarded: Effect.Effect<ReadonlyMap<string, OpenRetraction>, RevisionError>
}

/**
 * A code-owned page is written only by the owner, and stays where code finds it: only Arden's
 * own forget makes it, and no writer moves, renames, merges or archives it.
 */
const requireSystemPageKept = Effect.fn("Wiki.requireSystemPageKept")(function* (
  { repository, origin }: CommitView,
  operation: WikiPageOperation
): Effect.fn.Return<void, WikiCommitError> {
  const before = operation._tag === "Create" ? null : yield* repository.get(operation.resourceId)
  const paths = [before?.path, "path" in operation ? operation.path : undefined]
  const path = paths.find((candidate) => candidate !== undefined && isSystemPage(candidate))
  if (path === undefined) return
  if (!isOwnerOrigin(origin))
    return yield* ruleError(
      "code_owned",
      `${path} is kept by Arden for the owner. Nothing was saved; leave it unchanged.`
    )
  if (yield* keepsSystemPage(origin, operation, before)) return
  return yield* ruleError(
    "code_owned",
    `${path} is where Arden keeps what the owner asked to forget, so it cannot be made, moved, renamed, merged or archived by hand. ` +
      "Nothing was saved. To let a line back, undo its entry in a chat or delete the entry from the page."
  )
})

const pageBody = (bytes: Uint8Array): Effect.Effect<string> => {
  const text = decoder.decode(bytes)
  return parseWikiPage(text).pipe(
    Effect.map((page) => page.body),
    Effect.orElseSucceed(() => text)
  )
}

const requireNoRetractedLine = Effect.fn("Wiki.requireNoRetractedLine")(function* (
  { repository, guarded }: CommitView,
  operation: WikiPageOperation
): Effect.fn.Return<void, WikiCommitError> {
  if (operation._tag === "Archive") return
  const lines = yield* guarded
  if (lines.size === 0) return
  const before = operation._tag === "Create" ? null : yield* repository.get(operation.resourceId)
  const path = ("path" in operation ? operation.path : undefined) ?? before?.path
  const given = "content" in operation ? operation.content : undefined
  const source = given ?? (operation._tag === "Restore" ? before : null)
  if (path === undefined || isSystemPage(path) || source === null) return
  const after = yield* pageBody(
    source instanceof Uint8Array ? source : yield* repository.readVersion(source)
  )
  const had =
    before === null || operation._tag === "Restore" || before.state !== "active"
      ? undefined
      : yield* pageBody(yield* repository.readVersion(before))
  const entry = putBack(lines, had, after)
  if (entry !== undefined) return yield* ruleError("retraction", retractionRefusal(path, entry))
})

/** Every rule on what a writer may commit, each bound to the writers it holds for. */
const COMMIT_RULES: ReadonlyArray<{
  readonly binds: (origin: WikiCommitOrigin) => boolean
  readonly check: (
    view: CommitView,
    operation: WikiPageOperation
  ) => Effect.Effect<void, WikiCommitError>
}> = [
  { binds: () => true, check: (_view, operation) => requireHumanAliases(operation) },
  { binds: isUpkeep, check: requireNotRecord },
  { binds: () => true, check: requireNoMoveIntoRecords },
  { binds: isAutomatedOrigin, check: requireAutomatedRecordWrite },
  { binds: isAutomatedOrigin, check: requireAutomatedRetirement },
  { binds: (origin) => !isOutsideEdit(origin), check: refuseGrowthOverLimit },
  { binds: () => true, check: requireSystemPageKept },
  { binds: (origin) => !isOwnerOrigin(origin), check: requireNoRetractedLine }
]

/** Fails with the first rule that refuses one of `operations` for this writer. */
export const requireCommitRules = Effect.fn("Wiki.requireCommitRules")(function* (
  repository: ManagedFileRepositoryShape,
  origin: WikiCommitOrigin,
  operations: ReadonlyArray<WikiPageOperation>
): Effect.fn.Return<void, WikiCommitError> {
  const view: CommitView = {
    repository,
    origin,
    folders: yield* Effect.cached(currentRecordFolders(repository)),
    guarded: yield* Effect.cached(openRetractions(repository).pipe(Effect.map(guardedLines)))
  }
  for (const rule of COMMIT_RULES) {
    if (!rule.binds(origin)) continue
    for (const operation of operations) yield* rule.check(view, operation)
  }
})
