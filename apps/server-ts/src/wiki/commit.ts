import {
  type CommitInput,
  type CommitResult,
  InvalidRevisionInputError,
  type ManagedFileRepositoryShape,
  type ResourceVersion,
  type RevisionError
} from "@arden-hq/revisions/effect"
import { Effect, Option } from "effect"

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

export const encodeWikiOrigin = (origin: WikiCommitOrigin): string => {
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
  return requireHumanAliases(operations).pipe(
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

const requireHumanAliases = (
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
