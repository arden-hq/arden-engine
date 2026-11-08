import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import type { SpaceStore } from "../persistence/spaces/store.js"
import { DIRECTORY_CONTRACT_HEADINGS, directorySections } from "./collections.js"
import { commitWiki, createPage } from "./commit.js"
import { mapRevisionError, wikiError, type WikiError } from "./errors.js"
import { formatWikiPage, normal, pageNamesForPath, parseWikiPage } from "./page.js"
import { loadSnapshot } from "./snapshot.js"
import { spacePageSlug } from "@arden-hq/protocol/views"

export interface WikiSpacePageInput {
  readonly home?: "projects" | "areas"
  readonly spaceId: string
  readonly title: string
}

export const createWikiSpacePage = Effect.fn("Wiki.createSpacePageCommit")(function* (
  repository: ManagedFileRepositoryShape,
  spaces: SpaceStore["Service"],
  input: WikiSpacePageInput
): Effect.fn.Return<string, WikiError> {
  const title = input.title.trim()
  if (title.length === 0) {
    return yield* wikiError("create", "invalid", "Space page title must not be empty")
  }
  const current = yield* loadSnapshot(repository, "create")
  const home = input.home ?? "areas"
  const directoryPath = `${home}/README.md`
  const directory = current.pages.find(
    (record) => record.resource.path.toLowerCase() === directoryPath.toLowerCase()
  )
  const directoryNames = new Set(pageNamesForPath(directoryPath).map(normal))
  const conflictingDirectory = current.pages.some(
    (record) =>
      record !== directory &&
      pageNamesForPath(record.resource.path).some((name) => directoryNames.has(normal(name)))
  )
  const spaceOwned = yield* spaces
    .ownsWikiPath(directoryPath)
    .pipe(
      Effect.mapError((cause) =>
        wikiError("create", "storage", "Could not check Space directory ownership", { cause })
      )
    )
  const root = current.pages.find((record) => record.resource.path.toLowerCase() === "readme.md")
  const sections = directory === undefined ? undefined : directorySections(directory.page.body)
  if (
    conflictingDirectory ||
    spaceOwned ||
    (root !== undefined && Object.hasOwn(root.page.metadata, "producer_automation_id")) ||
    (directory !== undefined &&
      (directory.page.lifecycle !== "active" ||
        Object.hasOwn(directory.page.metadata, "producer_automation_id") ||
        DIRECTORY_CONTRACT_HEADINGS.some((heading) => !sections?.get(heading))))
  ) {
    return yield* wikiError(
      "create",
      "blocked",
      `The ${home} directory must be an active, unowned collection with a valid directory contract`
    )
  }
  const usedNames = new Set(
    current.pages.flatMap((record) => pageNamesForPath(record.resource.path).map(normal))
  )
  const base = spacePageSlug(title)
  let suffix = 1
  let path = `${home}/${base}.md`
  while (pageNamesForPath(path).some((name) => usedNames.has(normal(name)))) {
    suffix += 1
    path = `${home}/${base}-${suffix}.md`
  }
  const targetOwned = yield* spaces
    .ownsWikiPath(path)
    .pipe(
      Effect.mapError((cause) =>
        wikiError("create", "storage", "Could not check Space page ownership", { cause })
      )
    )
  if (targetOwned)
    return yield* wikiError("create", "blocked", "Another Space owns this Memory destination")
  const directoryId = randomUUID()
  const directoryContent = formatWikiPage({
    pageId: directoryId,
    title: home === "areas" ? "Areas" : "Projects",
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: {},
    body: `# ${home === "areas" ? "Areas" : "Projects"}

## Purpose

${home === "areas" ? "Ongoing responsibilities, practices and Space context." : "Finite outcomes and their specific context, decisions and state."}

## Producers

Users and agents maintaining supported context.

## Consumers

Chats and Spaces seeking relevant context.

## Boundaries

Finite outcomes belong in projects; reusable references belong in resources. Link to them instead of copying their state. Tasks own actions.

## Retention

Keep useful context; archive obsolete pages deliberately and preserve evidence.
`
  })
  const pageId = randomUUID()
  const content = formatWikiPage({
    pageId,
    title,
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: {},
    body: `# ${title}\n\n## Open loops\n\n## Related\n`
  })
  yield* parseWikiPage(content, pageId).pipe(
    Effect.mapError((cause) => wikiError("create", "invalid", cause.message, { pageId, cause }))
  )
  yield* commitWiki(
    repository,
    {
      expectedRevision: current.head,
      actor: "user:space",
      origin: { kind: "space_page" },
      reason: `attach Memory page to Space ${input.spaceId}`
    },
    [
      ...(directory === undefined
        ? [createPage(directoryId, directoryPath, directoryContent)]
        : []),
      createPage(pageId, path, content)
    ]
  ).pipe(Effect.mapError(mapRevisionError("create", pageId)))
  return pageId
})
