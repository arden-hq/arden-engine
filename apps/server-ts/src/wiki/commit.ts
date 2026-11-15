import {
  type AdoptableWorkingChange,
  type CommitInput,
  type CommitResult,
  InvalidRevisionInputError,
  type ManagedFileRepositoryShape,
  type ResourceVersion,
  type RevisionError
} from "@arden-hq/revisions/effect"
import { Effect, Option } from "effect"

import { CORE_CONDENSE_ADVICE, coreCondenseTarget, corePageBudget } from "../memory/core-memory.js"
import { aliasesAreHuman, parseWikiPage } from "./page.js"

export type WikiCommitOrigin =
  | { readonly kind: "user"; readonly via: "filesystem" | `desktop${string}` }
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

export const LEGACY_MAINTENANCE_ORIGIN = "wiki.maintenance"

const AUTOMATION_PREFIX = "wiki.automation."
const CHAIN_MARK = "~"
const AGENT_ORIGIN = "wiki.agent"
const CAPTURE_ORIGIN = "memory.capture"

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

export const commitWiki = (
  repository: ManagedFileRepositoryShape,
  options: WikiCommitIdentity & {
    readonly expectedRevision: string | null
    readonly idempotencyKey?: string
  },
  operations: ReadonlyArray<WikiPageOperation>
): Effect.Effect<CommitResult, RevisionError> => {
  const replayKey =
    options.idempotencyKey ??
    (options.origin.kind === "capture" ? options.origin.replayKey : undefined)
  return requireCommitRules(operations).pipe(
    Effect.andThen(requireWithinLimits(repository, operations)),
    Effect.andThen(
      repository.commit({
        actor: options.actor,
        origin: encodeWikiOrigin(options.origin),
        reason: options.reason,
        operations,
        ...(options.expectedRevision === null
          ? { expectedHead: null, enforceExpectedHead: true }
          : { expectedHead: options.expectedRevision }),
        ...(replayKey === undefined ? {} : { idempotencyKey: replayKey })
      })
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

const limitRefusal = (path: string, over: { readonly chars: number; readonly limit: number }) => {
  const target = coreCondenseTarget(over.limit)
  return new InvalidRevisionInputError({
    message:
      `${path} would have ${over.chars} characters, but it is sent whole to every run and is limited to ${over.limit}. ` +
      `Nothing was saved. Cut at least ${over.chars - over.limit} characters; aim for ${target} or fewer ` +
      `(${over.chars - target} less) so later updates fit. Trimming a few words will not do it. ` +
      `${CORE_CONDENSE_ADVICE} Then retry with the new fact included.`
  })
}

/**
 * The size limit binds every writer inside Arden; an outside edit is taken in over it. A write
 * that does not grow a page already over its limit goes through, so the page can be shortened,
 * renamed or moved in steps.
 */
const requireWithinLimits = (
  repository: ManagedFileRepositoryShape,
  operations: ReadonlyArray<WikiPageOperation>
): Effect.Effect<void, RevisionError> =>
  Effect.forEach(operations, (operation) => requireWithinLimit(repository, operation), {
    discard: true
  })

const requireWithinLimit = Effect.fn("Wiki.requireWithinLimit")(function* (
  repository: ManagedFileRepositoryShape,
  operation: WikiPageOperation
): Effect.fn.Return<void, RevisionError> {
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
  return yield* limitRefusal(path, over)
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

/**
 * Record one change made outside Arden that is already in the page's file. It meets the same
 * commit-point rules as `commitWiki`, and is guarded by the head the caller decided on.
 */
export const commitOutsideChange = (
  repository: ManagedFileRepositoryShape,
  options: WikiCommitIdentity & { readonly expectedRevision: string | null },
  change: AdoptableWorkingChange
): Effect.Effect<CommitResult, RevisionError> =>
  requireCommitRules(
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

/** The rules every Memory write meets at the commit point, outside edits included. */
const requireCommitRules = (
  operations: ReadonlyArray<WikiPageOperation>
): Effect.Effect<void, InvalidRevisionInputError> =>
  Effect.forEach(
    operations,
    (operation) => {
      const content = "content" in operation ? operation.content : undefined
      if (content === undefined) return Effect.void
      return parseWikiPage(decoder.decode(content)).pipe(
        Effect.option,
        Effect.flatMap((page) =>
          Option.isNone(page) || aliasesAreHuman(page.value.title, page.value.aliases)
            ? Effect.void
            : Effect.fail(
                new InvalidRevisionInputError({
                  message: `Wiki page ${operation.resourceId} keeps a path or a repeated name as an alias`
                })
              )
        )
      )
    },
    { discard: true }
  )
