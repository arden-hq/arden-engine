import { WIKI_REPORT_FIELDS } from "@arden-hq/protocol/wiki"
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
import {
  DIRECTORY_CONTRACT_HEADINGS,
  directorySections,
  markedProducer,
  pageKind,
  recordFolders
} from "./collections.js"
import { createPage, movePage, updatePage, type WikiCommitIdentity } from "./commit.js"
import { type WikiError, wikiError } from "./errors.js"
import { writerOf, type WikiChanges, type WikiPlan } from "./page-change.js"
import { formatWikiPage, parseWikiPage, reviseWikiPage } from "./page.js"
import { directoryReadme, nameTakenBy } from "./snapshot.js"
import { spaceOwnsWikiPath } from "./space-index.js"

const DIRECTORY_CONTRACT_HEADING = "## Directory contract"
const MAX_DIRECTORY_PATH_CHARS = 4_096
const MAX_DIRECTORY_CONTRACT_CHARS = 40_000

export interface WikiCreateDirectoryInput {
  readonly path: string
  readonly body: string
  readonly authority: WikiLocationAuthority
  readonly producerAutomationId?: string
  readonly commit: WikiCommitIdentity
}

interface WikiDirectoryWriteResult {
  readonly pageId: string
  readonly changed: boolean
  readonly adopted: boolean
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

export const createWikiDirectory = Effect.fn("Wiki.createDirectory")(function* (
  changes: WikiChanges,
  spaces: SpaceStore["Service"],
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
  const readmePath = `${directory}/README.md`
  const planned = yield* changes.change(
    writerOf("create", input),
    Effect.fn("Wiki.planDirectory")(function* (snapshot): Effect.fn.Return<
      WikiPlan<WikiDirectoryWriteResult>,
      WikiError
    > {
      const boundary = yield* resolveWikiWriteBoundary(spaces, input.authority, snapshot, "create")
      if (boundary === undefined) {
        const spaceOwned = yield* spaceOwnsWikiPath(spaces, readmePath).pipe(
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
      const placed = pageKind(recordFolders(snapshot.wholeSet), readmePath)
      if (placed.kind === "record" && placed.folder.producer.kind === "automation") {
        return yield* wikiError(
          "create",
          "blocked",
          "Report destinations cannot contain nested directories"
        )
      }
      const parent = posix.dirname(directory)
      if (parent !== "." && directoryReadme(snapshot.wholeSet, parent) === undefined) {
        return yield* wikiError(
          "create",
          "blocked",
          `Parent Wiki directory does not exist: ${parent}`
        )
      }

      const current = snapshot.wholeSet.find(
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
        const boundProducer = markedProducer(current.page)
        if (producerAutomationId !== undefined && boundProducer !== producerAutomationId) {
          const occupied = snapshot.wholeSet.some(
            (record) =>
              record.resource.path.toLowerCase().startsWith(`${directory.toLowerCase()}/`) &&
              record.page.pageId !== current.page.pageId
          )
          if (boundProducer !== undefined || occupied) {
            return yield* wikiError(
              "create",
              "blocked",
              "Only an empty, unowned directory can become a report destination"
            )
          }
          return {
            writes: [
              updatePage(
                current.resource,
                formatWikiPage({
                  ...current.page,
                  metadata: {
                    ...current.page.metadata,
                    [WIKI_REPORT_FIELDS.automationId]: producerAutomationId
                  }
                })
              )
            ],
            reason: "Bind report destination",
            value: { pageId: current.page.pageId, changed: true, adopted: false }
          }
        }
        return {
          writes: [],
          value: {
            pageId: current.page.pageId,
            changed: false,
            adopted: current.page.body.trimEnd() !== contract.trimEnd()
          }
        }
      }

      const occupant = snapshot.wholeSet.find(
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
      const nameOwner = nameTakenBy(snapshot, readmePath, occupant?.page.pageId)
      if (nameOwner !== undefined) {
        return yield* wikiError(
          "create",
          "conflict",
          `Wiki directory name already belongs to another page: ${directory}`,
          { pageId: nameOwner.page.pageId }
        )
      }

      if (occupant !== undefined && !ownsLeafBoundary) {
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
        return {
          writes: [movePage(occupant.resource, readmePath, content)],
          value: { pageId: occupant.page.pageId, changed: true, adopted: true }
        }
      }

      const pageId = randomUUID()
      const content = formatWikiPage({
        pageId,
        title: directoryTitle(directory),
        aliases: [],
        lifecycle: "active",
        redirectTo: null,
        metadata:
          producerAutomationId === undefined
            ? {}
            : { [WIKI_REPORT_FIELDS.automationId]: producerAutomationId },
        body: contract
      })
      yield* parseWikiPage(content, pageId).pipe(
        Effect.mapError((cause) => wikiError("create", "invalid", cause.message, { pageId, cause }))
      )
      return {
        writes: [createPage(pageId, readmePath, content)],
        value: { pageId, changed: true, adopted: false }
      }
    })
  )
  return planned.value
})
