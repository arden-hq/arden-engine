import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { posix } from "node:path"

import type { SpaceStore } from "../persistence/spaces/store.js"
import {
  authorityOwnsBoundaryPage,
  requireWikiWritePaths,
  resolveWikiWriteBoundary,
  type WikiLocationAuthority
} from "./authority.js"
import { DIRECTORY_CONTRACT_HEADINGS, directorySections } from "./collections.js"
import {
  commitWiki,
  createPage,
  movePage,
  updatePage,
  type WikiCommitIdentity,
  type WikiCommitOrigin
} from "./commit.js"
import { mapRevisionError, WikiError, wikiError } from "./errors.js"
import { formatWikiPage, normal, pageNamesForPath, parseWikiPage, reviseWikiPage } from "./page.js"
import { loadSnapshot } from "./snapshot.js"

const DIRECTORY_CONTRACT_HEADING = "## Directory contract"
const MAX_DIRECTORY_PATH_CHARS = 4_096
const MAX_DIRECTORY_CONTRACT_CHARS = 40_000

export interface WikiCreateDirectoryInput {
  readonly path: string
  readonly body: string
  readonly authority: WikiLocationAuthority
  readonly producerAutomationId?: string
  readonly commit?: WikiCommitIdentity
}

interface WikiDirectoryWriteResult {
  readonly pageId: string
  readonly changed: boolean
  readonly adopted: boolean
}

export interface WikiDirectoryMethods {
  readonly createDirectory: (
    input: WikiCreateDirectoryInput
  ) => Effect.Effect<WikiDirectoryWriteResult, WikiError>
}

const directoryPath = (value: string): string | undefined => {
  if (
    value.length === 0 ||
    value.length > MAX_DIRECTORY_PATH_CHARS ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    return undefined
  }
  if (value.includes("\\") || value.includes("\u0000")) return undefined
  return value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    ? undefined
    : value
}

export const directoryContract = (value: string): string | undefined => {
  if (value.length > MAX_DIRECTORY_CONTRACT_CHARS) return undefined
  const sections = directorySections(value)
  if (DIRECTORY_CONTRACT_HEADINGS.some((heading) => !sections.get(heading))) return undefined
  return `${value.trimEnd()}\n`
}

export const directoryTitle = (directory: string): string => {
  const name = directory.slice(directory.lastIndexOf("/") + 1)
  const label = name
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ")
  return `${label} README`
}

const adoptedDirectoryBody = (body: string, contract: string): string =>
  `${body.trimEnd()}\n\n${DIRECTORY_CONTRACT_HEADING}\n\n${contract}`

const hasDirectoryContract = (body: string, contract: string): boolean => {
  const normalized = body.trimEnd()
  const requested = contract.trimEnd()
  return (
    normalized === requested || normalized.endsWith(`${DIRECTORY_CONTRACT_HEADING}\n\n${requested}`)
  )
}

export const makeWikiDirectoryMethods = (
  repository: ManagedFileRepositoryShape,
  spaces: SpaceStore["Service"]
): WikiDirectoryMethods => {
  const createDirectory = Effect.fn("Wiki.createDirectory")(function* (
    input: WikiCreateDirectoryInput
  ) {
    const producerAutomationId = input.producerAutomationId
    const directory = directoryPath(input.path)
    if (directory === undefined) {
      return yield* wikiError(
        "create",
        "invalid",
        "Wiki directories must use a relative POSIX path without a trailing slash"
      )
    }
    const contract = directoryContract(input.body)
    if (contract === undefined) {
      return yield* wikiError(
        "create",
        "invalid",
        `Wiki directory contracts require exact headings: ${DIRECTORY_CONTRACT_HEADINGS.map((heading) => `## ${heading}`).join(", ")}`
      )
    }
    if (directory.toLowerCase() === "health") {
      return yield* wikiError("create", "blocked", "Wiki health is backend-managed")
    }

    const snapshot = yield* loadSnapshot(repository, "create")
    const readmePath = `${directory}/README.md`
    const boundary = yield* resolveWikiWriteBoundary(spaces, input.authority, snapshot, "create")
    if (boundary === undefined) {
      const spaceOwned = yield* spaces
        .ownsWikiPath(readmePath)
        .pipe(
          Effect.mapError((cause) =>
            wikiError("create", "storage", "Could not validate Space Wiki ownership", { cause })
          )
        )
      if (spaceOwned) {
        return yield* wikiError(
          "create",
          "blocked",
          "Only the owning Space run may create or adopt directories inside a Space Wiki boundary"
        )
      }
    }
    yield* requireWikiWritePaths(boundary, "create", [readmePath])
    const ownedAncestor = snapshot.pages.find(
      (record) =>
        record.page.lifecycle === "active" &&
        posix.basename(record.resource.path).toLowerCase() === "readme.md" &&
        Object.hasOwn(record.page.metadata, "producer_automation_id") &&
        readmePath
          .toLowerCase()
          .startsWith(`${posix.dirname(record.resource.path).toLowerCase()}/`) &&
        record.resource.path.toLowerCase() !== readmePath.toLowerCase()
    )
    if (ownedAncestor !== undefined) {
      return yield* wikiError(
        "create",
        "blocked",
        "Report destinations cannot contain nested directories"
      )
    }
    const parent = posix.dirname(directory)
    if (
      parent !== "." &&
      !snapshot.pages.some(
        (record) =>
          record.resource.path.toLowerCase() === `${parent}/readme.md`.toLowerCase() &&
          record.page.lifecycle === "active"
      )
    ) {
      return yield* wikiError(
        "create",
        "blocked",
        `Parent Wiki directory does not exist: ${parent}`
      )
    }

    const current = snapshot.pages.find(
      (record) => record.resource.path.toLowerCase() === readmePath.toLowerCase()
    )
    if (current !== undefined) {
      if (
        current.page.lifecycle !== "active" ||
        !hasDirectoryContract(current.page.body, contract)
      ) {
        return yield* wikiError(
          "create",
          "conflict",
          `Wiki directory already exists with a different contract: ${directory}`,
          { pageId: current.page.pageId }
        )
      }
      if (
        producerAutomationId !== undefined &&
        current.page.metadata["producer_automation_id"] !== producerAutomationId
      ) {
        const occupied = snapshot.pages.some(
          (record) =>
            record.resource.path.toLowerCase().startsWith(`${directory.toLowerCase()}/`) &&
            record.page.pageId !== current.page.pageId
        )
        if (Object.hasOwn(current.page.metadata, "producer_automation_id") || occupied) {
          return yield* wikiError(
            "create",
            "blocked",
            "Only an empty, unowned directory can become a report destination"
          )
        }
        yield* commitWiki(
          repository,
          {
            actor: input.commit?.actor ?? "Agent",
            origin: input.commit?.origin ?? { kind: "agent", sessionId: undefined },
            reason: "Bind report destination",
            expectedRevision: snapshot.head
          },
          [
            updatePage(
              current.resource,
              formatWikiPage({
                ...current.page,
                metadata: { ...current.page.metadata, producer_automation_id: producerAutomationId }
              })
            )
          ]
        ).pipe(Effect.mapError(mapRevisionError("create")))
        return { pageId: current.page.pageId, changed: true, adopted: false }
      }
      return {
        pageId: current.page.pageId,
        changed: false,
        adopted: current.page.body.trimEnd() !== contract.trimEnd()
      }
    }

    const occupant = snapshot.pages.find(
      (record) =>
        record.resource.path.toLowerCase() === `${directory}.md`.toLowerCase() &&
        record.page.lifecycle === "active"
    )
    if (occupant !== undefined && producerAutomationId !== undefined) {
      return yield* wikiError(
        "create",
        "blocked",
        "An existing subject page cannot become a report destination"
      )
    }
    if (occupant !== undefined) {
      yield* requireWikiWritePaths(boundary, "create", [occupant.resource.path])
    }
    const ownsLeafBoundary =
      occupant !== undefined &&
      authorityOwnsBoundaryPage(boundary, occupant.page.pageId, occupant.resource.path)
    const targetNames = new Set(pageNamesForPath(readmePath).map(normal))
    const nameOwner = snapshot.pages.find(
      (record) =>
        record.page.pageId !== occupant?.page.pageId &&
        pageNamesForPath(record.resource.path).some((name) => targetNames.has(normal(name)))
    )
    if (nameOwner !== undefined) {
      return yield* wikiError(
        "create",
        "conflict",
        `Wiki directory name already belongs to another page: ${directory}`,
        { pageId: nameOwner.page.pageId }
      )
    }

    const actor = input.commit?.actor ?? "memory:capture"
    const origin: WikiCommitOrigin = input.commit?.origin ?? {
      kind: "capture",
      replayKey: undefined,
      sessionId: undefined
    }
    const reason = input.commit?.reason ?? `create Wiki directory ${directory}`
    if (occupant !== undefined && !ownsLeafBoundary) {
      if (Object.hasOwn(occupant.page.metadata, "producer_automation_id")) {
        return yield* wikiError(
          "create",
          "blocked",
          "Automation-owned pages cannot be opened as Wiki directories",
          { pageId: occupant.page.pageId }
        )
      }
      const spaceBound = yield* spaces
        .hasPageBinding(occupant.page.pageId, occupant.resource.path)
        .pipe(
          Effect.mapError((cause) =>
            wikiError("create", "storage", "Could not check Space page ownership", {
              pageId: occupant.page.pageId,
              cause
            })
          )
        )
      if (spaceBound) {
        return yield* wikiError(
          "create",
          "blocked",
          "A Space owns this Wiki page, so it cannot be opened as a directory",
          { pageId: occupant.page.pageId }
        )
      }
      const content = yield* reviseWikiPage(occupant.page, {
        body: adoptedDirectoryBody(occupant.page.body, contract)
      }).pipe(
        Effect.mapError((cause) =>
          wikiError("create", "invalid", cause.message, {
            pageId: occupant.page.pageId,
            cause
          })
        )
      )
      yield* commitWiki(repository, { actor, origin, reason, expectedRevision: snapshot.head }, [
        movePage(occupant.resource, readmePath, content)
      ]).pipe(Effect.mapError(mapRevisionError("create", occupant.page.pageId)))
      return { pageId: occupant.page.pageId, changed: true, adopted: true }
    }

    const pageId = randomUUID()
    const content = formatWikiPage({
      pageId,
      title: directoryTitle(directory),
      aliases: [],
      lifecycle: "active",
      redirectTo: null,
      metadata:
        producerAutomationId === undefined ? {} : { producer_automation_id: producerAutomationId },
      body: contract
    })
    yield* parseWikiPage(content, pageId).pipe(
      Effect.mapError((cause) => wikiError("create", "invalid", cause.message, { pageId, cause }))
    )
    yield* commitWiki(repository, { actor, origin, reason, expectedRevision: snapshot.head }, [
      createPage(pageId, readmePath, content)
    ]).pipe(Effect.mapError(mapRevisionError("create", pageId)))
    return { pageId, changed: true, adopted: false }
  })

  return { createDirectory }
}
