import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import type {
  PersistedSpace,
  SpaceBinding,
  SpaceStore,
  SpaceStoreError
} from "../persistence/spaces/store.js"
import {
  DIRECTORY_CONTRACT_HEADINGS,
  directorySections,
  pageKind,
  recordFolders
} from "./collections.js"
import { commitWiki, createPage } from "./commit.js"
import { mapRevisionError, wikiError, type WikiError } from "./errors.js"
import { formatWikiPage, normal, pageNamesForPath, parseWikiPage } from "./page.js"
import { loadSnapshot, type Snapshot } from "./snapshot.js"
import { bindingOwnsPath, overlapsAnother, planSpacePage } from "./space-index.js"
import { spacePageSlug } from "@arden-hq/protocol/views"
import type { CreateSpaceInput } from "@arden-hq/protocol/spaces"
import type { MutationOperationIdentity } from "../persistence/tools/mutation-receipt.js"
import type { WikiMutationMethods } from "./mutations.js"

export interface WikiSpacePageInput {
  readonly spaceId: string
  /** Where a page made now goes; the default is areas. */
  readonly home?: "projects" | "areas"
}

/** An active Space with its page, and the page made for it, if one was made. */
export interface SpacePageEnsured {
  readonly space: PersistedSpace
  readonly created: { readonly pageId: string; readonly path: string } | undefined
}

const storageError = (message: string) => (cause: unknown) =>
  wikiError("create", "storage", message, { cause })

/**
 * The one way a Space gets its page: keeps the page it has, binds it again where it was
 * renamed to, or makes and binds a fresh one. Undefined when the Space is not active.
 */
export const ensureWikiSpacePage = Effect.fn("Wiki.ensureSpacePage")(function* (
  repository: ManagedFileRepositoryShape,
  spaces: SpaceStore["Service"],
  input: WikiSpacePageInput
): Effect.fn.Return<SpacePageEnsured | undefined, WikiError> {
  const space = yield* spaces
    .get(input.spaceId)
    .pipe(Effect.mapError(storageError("Could not read the Space")))
  if (space === null) return undefined
  const current = yield* loadSnapshot(repository, "create")
  const others = (yield* spaces
    .activeBindings()
    .pipe(Effect.mapError(storageError("Could not read the Spaces' Memory pages")))).filter(
    (binding) => binding.space_id !== space.space_id
  )
  const plan = planSpacePage(current.pages, space, others)
  if (plan.kind === "keep") return { space, created: undefined }
  const page =
    plan.kind === "rebind"
      ? { pageId: plan.pageId, path: plan.pagePath }
      : yield* createSpacePage(repository, current, others, {
          spaceId: space.space_id,
          title: space.name,
          home: input.home ?? "areas"
        })
  const bound = yield* spaces
    .bindPage(space.space_id, page.pageId, page.path)
    .pipe(Effect.mapError(storageError("Could not bind the Space's page")))
  if (bound === null) return undefined
  return { space: bound, created: plan.kind === "create" ? page : undefined }
})

/** Logs a Space left without a page; the start check gives it one. */
export const logNoSpacePage = (spaceId: string, error: WikiError) =>
  Effect.logWarning("A Space has no Memory page; the next start tries again", {
    spaceId,
    reason: error.reason,
    message: error.message
  })

/**
 * Restores an archived Space in one write with the page it keeps or is bound to again, or with
 * none, so it never comes back holding a page another active Space holds or overlaps. A Space
 * that comes back with none then gets a fresh page, or the start check gives it one.
 */
export const restoreWikiSpace = Effect.fn("Wiki.restoreSpace")(function* (
  repository: ManagedFileRepositoryShape,
  spaces: SpaceStore["Service"],
  spaceId: string
): Effect.fn.Return<PersistedSpace | null, WikiError | SpaceStoreError> {
  const space = yield* spaces.get(spaceId, true)
  if (space === null || space.archived_at === null) return null
  const current = yield* loadSnapshot(repository, "restore")
  const plan = planSpacePage(current.pages, space, yield* spaces.activeBindings())
  const restored = yield* spaces.restore(
    spaceId,
    plan.kind === "create" ? null : { pageId: plan.pageId, pagePath: plan.pagePath }
  )
  if (restored === null || plan.kind !== "create") return restored
  return yield* ensureWikiSpacePage(repository, spaces, { spaceId }).pipe(
    Effect.map((ensured) => ensured?.space ?? restored),
    Effect.catch((error) => logNoSpacePage(spaceId, error).pipe(Effect.as(restored)))
  )
})

const createSpacePage = Effect.fn("Wiki.createSpacePageCommit")(function* (
  repository: ManagedFileRepositoryShape,
  current: Snapshot,
  others: ReadonlyArray<SpaceBinding>,
  input: { readonly spaceId: string; readonly title: string; readonly home: "projects" | "areas" }
): Effect.fn.Return<{ readonly pageId: string; readonly path: string }, WikiError> {
  const title = input.title.trim()
  if (title.length === 0) {
    return yield* wikiError("create", "invalid", "Space page title must not be empty")
  }
  const home = input.home
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
  const spaceOwned = others.some((binding) => bindingOwnsPath(binding, directoryPath))
  const sections = directory === undefined ? undefined : directorySections(directory.page.body)
  if (
    conflictingDirectory ||
    spaceOwned ||
    pageKind(recordFolders(current.pages), directoryPath).kind !== "knowledge" ||
    (directory !== undefined &&
      (directory.page.lifecycle !== "active" ||
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
  while (
    pageNamesForPath(path).some((name) => usedNames.has(normal(name))) ||
    overlapsAnother(others, path)
  ) {
    suffix += 1
    path = `${home}/${base}-${suffix}.md`
  }
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
  return { pageId, path }
})

type EnsureSpacePage = Pick<WikiMutationMethods, "ensureSpacePage">

/**
 * The Space with its page. A page that cannot be made now is logged and made at the next
 * start, so a Space is never refused for its page.
 */
const withSpacePage = (
  wiki: EnsureSpacePage,
  space: PersistedSpace,
  home: WikiSpacePageInput["home"]
) =>
  wiki.ensureSpacePage({ spaceId: space.space_id, ...(home === undefined ? {} : { home }) }).pipe(
    Effect.map((ensured) => ensured?.space ?? space),
    Effect.catch((error) => logNoSpacePage(space.space_id, error).pipe(Effect.as(space)))
  )

/** The one way a Space is created: the Space, then its page in `home`. */
export const createSpaceWithPage = Effect.fn("Spaces.createWithPage")(function* (
  services: {
    readonly spaces: Pick<SpaceStore["Service"], "create">
    readonly wiki: EnsureSpacePage
  },
  input: CreateSpaceInput,
  options: {
    readonly mutation?: MutationOperationIdentity
    readonly home?: WikiSpacePageInput["home"]
  } = {}
) {
  const space = yield* services.spaces.create(input, options.mutation)
  return yield* withSpacePage(services.wiki, space, options.home)
})
