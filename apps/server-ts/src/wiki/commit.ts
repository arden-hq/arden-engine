import type {
  AdoptableWorkingChange,
  CommitInput,
  CommitResult,
  ManagedFileRepositoryShape,
  ResourceVersion,
  RevisionError
} from "@arden-hq/revisions/effect"
import { Effect, Option, Schema } from "effect"

import { CORE_CONDENSE_ADVICE, coreCondenseTarget, corePageBudget } from "../memory/core-memory.js"
import { aliasesAreHuman, parseWikiPage } from "./page.js"
import { guardedLines, openRetractions, putBack, retractionRefusal } from "./retraction.js"
import { isSystemPage } from "./system-pages.js"

export type WikiCommitOrigin =
  /** The owner, in the app or in the file. */
  | { readonly kind: "user"; readonly via: "filesystem" | `desktop${string}` }
  /** The owner's own chat turn, forgetting or undoing a retraction after their approval. */
  | { readonly kind: "forget"; readonly sessionId: string }
  | { readonly kind: "agent"; readonly sessionId: string | undefined }
  | { readonly kind: "automation"; readonly automationId: string; readonly chainDepth?: number }
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
    case "space_page":
    case "system":
      return undefined
  }
}

export const isAutomatedOrigin = (origin: WikiCommitOrigin): boolean =>
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
  rule: Schema.Literals(["aliases", "size", "code_owned", "retraction"] as const),
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
    : repository
        .idempotencyReceipt(replayKey)
        .pipe(Effect.flatMap((receipt) => (receipt === null ? checked : commit)))
}

/**
 * Record one change made outside Arden that is already in the page's file. It meets the commit
 * rules that bind an outside edit, and is guarded by the head the caller decided on.
 */
export const commitOutsideChange = (
  repository: ManagedFileRepositoryShape,
  options: WikiCommitIdentity & { readonly expectedRevision: string | null },
  change: AdoptableWorkingChange
): Effect.Effect<CommitResult, WikiCommitError> =>
  requireCommitRules(
    repository,
    options.origin,
    change.kind === "changed"
      ? [
          {
            _tag: "Update",
            resourceId: change.resource.resourceId,
            expectedVersion: change.resource.versionId,
            content: change.content
          }
        ]
      : []
  ).pipe(
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
    message:
      origin.kind === "user"
        ? `${path} would have ${over.chars} characters; its limit is ${over.limit}, because it is sent whole to every chat. ` +
          `Nothing was saved. Shorten it by at least ${over.chars - over.limit} characters.`
        : `${path} would have ${over.chars} characters, but it is sent whole to every run and is limited to ${over.limit}. ` +
          `Nothing was saved. Cut at least ${over.chars - over.limit} characters; aim for ${target} or fewer ` +
          `(${over.chars - target} less) so later updates fit. Trimming a few words will not do it. ` +
          `${CORE_CONDENSE_ADVICE} Then retry with the new fact included.`
  })
}

const requireWithinLimit = Effect.fn("Wiki.requireWithinLimit")(function* (
  repository: ManagedFileRepositoryShape,
  origin: WikiCommitOrigin,
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

const requireNoSystemPage = Effect.fn("Wiki.requireNoSystemPage")(function* (
  repository: ManagedFileRepositoryShape,
  operation: WikiPageOperation
): Effect.fn.Return<void, WikiCommitError> {
  const before = operation._tag === "Create" ? null : yield* repository.get(operation.resourceId)
  const paths = [before?.path, "path" in operation ? operation.path : undefined]
  const path = paths.find((candidate) => candidate !== undefined && isSystemPage(candidate))
  if (path === undefined) return
  return yield* new WikiCommitRuleError({
    rule: "code_owned",
    message: `${path} is kept by Arden for the owner. Nothing was saved; leave it unchanged.`
  })
})

const pageBody = (bytes: Uint8Array): Effect.Effect<string> => {
  const text = decoder.decode(bytes)
  return parseWikiPage(text).pipe(
    Effect.map((page) => page.body),
    Effect.orElseSucceed(() => text)
  )
}

const requireNoRetractedLine = Effect.fn("Wiki.requireNoRetractedLine")(function* (
  repository: ManagedFileRepositoryShape,
  operations: ReadonlyArray<WikiPageOperation>
): Effect.fn.Return<void, WikiCommitError> {
  const guarded = guardedLines(yield* openRetractions(repository))
  if (guarded.size === 0) return
  for (const operation of operations) {
    if (operation._tag === "Archive") continue
    const before = operation._tag === "Create" ? null : yield* repository.get(operation.resourceId)
    const path = ("path" in operation ? operation.path : undefined) ?? before?.path
    const given = "content" in operation ? operation.content : undefined
    const source = given ?? (operation._tag === "Restore" ? before : null)
    if (path === undefined || isSystemPage(path) || source === null) continue
    const after = yield* pageBody(
      source instanceof Uint8Array ? source : yield* repository.readVersion(source)
    )
    const had =
      before === null || operation._tag === "Restore" || before.state !== "active"
        ? undefined
        : yield* pageBody(yield* repository.readVersion(before))
    const entry = putBack(guarded, had, after)
    if (entry !== undefined)
      return yield* new WikiCommitRuleError({
        rule: "retraction",
        message: retractionRefusal(path, entry)
      })
  }
})

const eachOperation =
  (
    check: (
      repository: ManagedFileRepositoryShape,
      origin: WikiCommitOrigin,
      operation: WikiPageOperation
    ) => Effect.Effect<void, WikiCommitError>
  ) =>
  (
    repository: ManagedFileRepositoryShape,
    origin: WikiCommitOrigin,
    operations: ReadonlyArray<WikiPageOperation>
  ) =>
    Effect.forEach(operations, (operation) => check(repository, origin, operation), {
      discard: true
    })

/** What may be written, by whom. Each row binds the writers it names, at the one commit point. */
const COMMIT_RULES: ReadonlyArray<{
  readonly binds: (origin: WikiCommitOrigin) => boolean
  readonly check: (
    repository: ManagedFileRepositoryShape,
    origin: WikiCommitOrigin,
    operations: ReadonlyArray<WikiPageOperation>
  ) => Effect.Effect<void, WikiCommitError>
}> = [
  {
    binds: () => true,
    check: eachOperation((_repository, _origin, operation) => requireHumanAliases(operation))
  },
  { binds: (origin) => !isOutsideEdit(origin), check: eachOperation(requireWithinLimit) },
  {
    binds: (origin) => !isOwnerOrigin(origin),
    check: eachOperation((repository, _origin, operation) =>
      requireNoSystemPage(repository, operation)
    )
  },
  {
    binds: (origin) => !isOwnerOrigin(origin),
    check: (repository, _origin, operations) => requireNoRetractedLine(repository, operations)
  }
]

/** Fails with the first rule that refuses one of `operations` for this writer. */
export const requireCommitRules = (
  repository: ManagedFileRepositoryShape,
  origin: WikiCommitOrigin,
  operations: ReadonlyArray<WikiPageOperation>
): Effect.Effect<void, WikiCommitError> =>
  Effect.forEach(
    COMMIT_RULES.filter((rule) => rule.binds(origin)),
    (rule) => rule.check(repository, origin, operations),
    { discard: true }
  )
