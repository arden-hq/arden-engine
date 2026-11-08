import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { posix } from "node:path"

import { canonicalWikiPath, type WikiLocationAuthority } from "./authority.js"
import {
  commitWiki,
  createPage,
  updatePage,
  type WikiCommitIdentity,
  type WikiPageOperation
} from "./commit.js"
import { directoryContract, directoryTitle } from "./directories.js"
import { mapRevisionError, type WikiError, wikiError } from "./errors.js"
import { formatWikiPage, normal, pageNamesForPath } from "./page.js"
import { loadSnapshot, type Snapshot } from "./snapshot.js"

export const IMPORTED_DIRECTORY = "imported"

export const isImportedPath = (path: string): boolean =>
  path.toLowerCase().startsWith(`${IMPORTED_DIRECTORY}/`)

const HEAD_CONFLICT_RETRIES = 4

interface WikiImportInput {
  readonly directories: ReadonlyArray<{ readonly path: string; readonly contract: string }>
  readonly pages: ReadonlyArray<{
    readonly path: string
    readonly title: string
    readonly body: string
  }>
  readonly authority: WikiLocationAuthority
  readonly commit: WikiCommitIdentity
}

export interface CommittedPage {
  readonly pageId: string
  readonly path: string
  readonly title: string
  readonly beforeVersion: string
  readonly afterVersion: string
}

interface WikiImportResult {
  readonly created: ReadonlyArray<string>
  readonly updated: ReadonlyArray<string>
  readonly unchanged: ReadonlyArray<string>
  readonly committed: ReadonlyArray<CommittedPage>
}

export interface WikiImportMethods {
  readonly importReferencePages: (
    input: WikiImportInput
  ) => Effect.Effect<WikiImportResult, WikiError>
}

export const makeWikiImportMethods = (
  repository: ManagedFileRepositoryShape
): WikiImportMethods => {
  const attempt = Effect.fn("Wiki.importAttempt")(function* (input: WikiImportInput) {
    const snapshot = yield* loadSnapshot(repository, "create")
    const plan = yield* planImport(snapshot, input)
    if (plan.operations.length === 0) return { ...plan.result, committed: [] }
    const written = yield* commitWiki(
      repository,
      { ...input.commit, expectedRevision: snapshot.head },
      plan.operations
    ).pipe(Effect.mapError(mapRevisionError("create")))
    return {
      ...plan.result,
      committed: written.commit.changes.flatMap((change) => {
        const after = change.after
        if (after === null) return []
        return [
          {
            pageId: after.resourceId,
            path: after.path,
            title: plan.titles.get(after.resourceId) ?? posix.basename(after.path, ".md"),
            beforeVersion: change.before?.versionId ?? "absent",
            afterVersion: after.versionId
          }
        ]
      })
    }
  })

  const importReferencePages = Effect.fn("Wiki.importReferencePages")(function* (
    input: WikiImportInput
  ) {
    yield* requireImportable(input)
    return yield* attempt(input).pipe(
      Effect.retry({
        while: (error) => error.reason === "conflict",
        times: HEAD_CONFLICT_RETRIES
      })
    )
  })

  return { importReferencePages }
}

const requireImportable = Effect.fn("Wiki.requireImportable")(function* (input: WikiImportInput) {
  if (input.authority._tag !== "Global") {
    return yield* wikiError("create", "blocked", "Only a chat outside Spaces imports notes")
  }
  const paths = [
    ...input.directories.map((directory) => `${directory.path}/README.md`),
    ...input.pages.map((page) => page.path)
  ]
  const outside = paths.find(
    (path) => !isImportedPath(path) || !path.endsWith(".md") || canonicalWikiPath(path) !== path
  )
  if (outside !== undefined) {
    return yield* wikiError(
      "create",
      "invalid",
      `Imported pages live under ${IMPORTED_DIRECTORY}/: ${outside}`
    )
  }
  if (new Set(paths.map(normal)).size !== paths.length) {
    return yield* wikiError("create", "invalid", "An import names one page twice")
  }
  const invalid = input.directories.find(
    (directory) => directoryContract(directory.contract) === undefined
  )
  if (invalid !== undefined) {
    return yield* wikiError(
      "create",
      "invalid",
      `Directory contract is incomplete: ${invalid.path}`
    )
  }
})

const planImport = Effect.fn("Wiki.planImport")(function* (
  snapshot: Snapshot,
  input: WikiImportInput
) {
  const byPath = new Map(snapshot.pages.map((record) => [normal(record.resource.path), record]))
  const names = new Set(
    snapshot.pages.flatMap((record) => pageNamesForPath(record.resource.path).map(normal))
  )
  const operations: Array<WikiPageOperation> = []
  const created: Array<string> = []
  const updated: Array<string> = []
  const unchanged: Array<string> = []
  const known = new Set<string>()
  const titles = new Map<string, string>()

  const create = (path: string, title: string, body: string) => {
    const pageId = randomUUID()
    titles.set(pageId, title)
    operations.push(
      createPage(
        pageId,
        path,
        formatWikiPage({
          pageId,
          title,
          aliases: [],
          lifecycle: "active",
          redirectTo: null,
          metadata: {},
          body
        })
      )
    )
    known.add(normal(posix.dirname(path)))
  }

  for (const directory of input.directories) {
    const readme = `${directory.path}/README.md`
    const contract = directoryContract(directory.contract) ?? directory.contract
    const parent = posix.dirname(directory.path)
    if (
      parent !== "." &&
      !known.has(normal(parent)) &&
      !byPath.has(normal(`${parent}/README.md`))
    ) {
      return yield* wikiError(
        "create",
        "blocked",
        `Parent Wiki directory does not exist: ${parent}`
      )
    }
    const current = byPath.get(normal(readme))
    if (current === undefined) {
      if (pageNamesForPath(readme).some((name) => names.has(normal(name)))) {
        return yield* wikiError(
          "create",
          "blocked",
          `Wiki directory name already belongs to another page: ${directory.path}`
        )
      }
      create(readme, directoryTitle(directory.path), contract)
      continue
    }
    if (current.page.lifecycle !== "active") {
      return yield* wikiError("create", "blocked", `Imported directory is a redirect: ${readme}`, {
        pageId: current.page.pageId
      })
    }
    if (current.page.body.trimEnd() !== contract.trimEnd()) {
      titles.set(current.page.pageId, current.page.title)
      operations.push(
        updatePage(current.resource, formatWikiPage({ ...current.page, body: contract }))
      )
    }
    known.add(normal(directory.path))
  }

  for (const page of input.pages) {
    const directory = posix.dirname(page.path)
    if (!known.has(normal(directory))) {
      return yield* wikiError("create", "blocked", `Wiki directory is not mapped: ${directory}`)
    }
    const current = byPath.get(normal(page.path))
    if (current === undefined) {
      if (pageNamesForPath(page.path).some((name) => names.has(normal(name)))) {
        return yield* wikiError(
          "create",
          "blocked",
          `Wiki path or link name already exists: ${page.path}`
        )
      }
      create(page.path, page.title, page.body)
      created.push(page.path)
    } else if (current.page.lifecycle !== "active") {
      return yield* wikiError("create", "blocked", `Imported page is a redirect: ${page.path}`, {
        pageId: current.page.pageId
      })
    } else if (current.page.title === page.title && current.page.body.trim() === page.body.trim()) {
      unchanged.push(page.path)
    } else {
      titles.set(current.page.pageId, page.title)
      operations.push(
        updatePage(
          current.resource,
          formatWikiPage({ ...current.page, title: page.title, body: page.body })
        )
      )
      updated.push(page.path)
    }
  }
  return { operations, titles, result: { created, updated, unchanged } }
})
