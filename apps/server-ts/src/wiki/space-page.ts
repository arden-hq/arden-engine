import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import type {
  FreeSpacePage,
  PersistedSpace,
  SpaceStore,
  SpaceStoreError
} from "../persistence/spaces/store.js"
import {
  DIRECTORY_CONTRACT_HEADINGS,
  directorySections,
  pageKind,
  recordFolders
} from "./collections.js"
import { commitWiki, createPage, type WikiCommitPoint } from "./commit.js"
import { mapRevisionError, wikiError, type WikiError } from "./errors.js"
import { formatWikiPage, namesTakenAt, parseWikiPage, takesName } from "./page.js"
import { loadSnapshot, nameTakenBy, type Snapshot } from "./snapshot.js"
import {
  activeSpaceBindings,
  bindingOwnsPath,
  freeSpacePage,
  planSpacePage,
  type SpaceBinding
} from "./space-index.js"
import { spacePageSlug } from "@arden-hq/protocol/views"
import type { CreateSpaceInput } from "@arden-hq/protocol/spaces"
import type { MutationOperationIdentity } from "../persistence/tools/mutation-receipt.js"
import type { WikiMutationMethods } from "./mutations.js"

export interface WikiSpacePageInput {
  readonly spaceId: string
  /** Where a page made now goes; the default is areas. */
  readonly home?: "projects" | "areas"
}

/**
 * How an active Space has its page: the page it was bound to, that page at the path it now has,
 * or a page made for it now.
 */
export type SpacePageEnsured =
  | { readonly kind: "kept" | "rebound"; readonly space: PersistedSpace }
  | {
      readonly kind: "created"
      readonly space: PersistedSpace
      readonly created: { readonly pageId: string; readonly path: string }
    }

const storageError = (message: string) => (cause: unknown) =>
  wikiError("create", "storage", message, { cause })

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
  const others = (yield* activeSpaceBindings(spaces).pipe(
    Effect.mapError(storageError("Could not read the Spaces' Memory pages"))
  )).filter((binding) => binding.space_id !== space.space_id)
  const plan = planSpacePage(current.pages, space, others)
  if (plan.kind === "keep") return { kind: "kept", space }
  const page =
    plan.kind === "rebind"
      ? plan.page
      : yield* createSpacePage({ repository, spaces }, current, others, {
          spaceId: space.space_id,
          title: space.name,
          home: input.home ?? "areas"
        })
  const bound = yield* spaces
    .bindPage(space.space_id, page)
    .pipe(Effect.mapError(storageError("Could not bind the Space's page")))
  if (bound === null) return undefined
  return plan.kind === "rebind"
    ? { kind: "rebound", space: bound }
    : { kind: "created", space: bound, created: { pageId: page.pageId, path: page.pagePath } }
})

/** Logs a Space left without a page; the start check gives it one. */
export const logNoSpacePage = (spaceId: string, error: WikiError) =>
  Effect.logWarning("A Space has no Memory page; the next start tries again", {
    spaceId,
    reason: error.reason,
    message: error.message
  })

/**
 * How an archived Space came back. A Space whose page is gone, or held or overlapped by another
 * active Space, gets a fresh page; when none can be made now it comes back pageless, and the
 * next start gives it one.
 */
export type SpaceRestore = {
  readonly kind: SpacePageEnsured["kind"] | "pageless"
  readonly space: PersistedSpace
}

export const restoreWikiSpace = Effect.fn("Wiki.restoreSpace")(function* (
  repository: ManagedFileRepositoryShape,
  spaces: SpaceStore["Service"],
  spaceId: string
): Effect.fn.Return<SpaceRestore | null, WikiError | SpaceStoreError> {
  const space = yield* spaces.get(spaceId, true)
  if (space === null || space.archived_at === null) return null
  const current = yield* loadSnapshot(repository, "restore")
  const plan = planSpacePage(current.pages, space, yield* activeSpaceBindings(spaces))
  if (plan.kind !== "create") {
    const restored = yield* spaces.restore(spaceId, plan.page)
    return restored === null
      ? null
      : { kind: plan.kind === "keep" ? "kept" : "rebound", space: restored }
  }
  const restored = yield* spaces.restore(spaceId, null)
  if (restored === null) return null
  return yield* ensureWikiSpacePage(repository, spaces, { spaceId }).pipe(
    Effect.map((ensured): SpaceRestore => ensured ?? { kind: "pageless", space: restored }),
    Effect.catch((error) =>
      logNoSpacePage(spaceId, error).pipe(
        Effect.as<SpaceRestore>({ kind: "pageless", space: restored })
      )
    )
  )
})

const createSpacePage = Effect.fn("Wiki.createSpacePageCommit")(function* (
  point: WikiCommitPoint,
  current: Snapshot,
  others: ReadonlyArray<SpaceBinding>,
  input: { readonly spaceId: string; readonly title: string; readonly home: "projects" | "areas" }
): Effect.fn.Return<FreeSpacePage, WikiError> {
  const title = input.title.trim()
  if (title.length === 0) {
    return yield* wikiError("create", "invalid", "Space page title must not be empty")
  }
  const home = input.home
  const directoryPath = `${home}/README.md`
  const directory = current.wholeSet.find(
    (record) => record.resource.path.toLowerCase() === directoryPath.toLowerCase()
  )
  const conflictingDirectory =
    nameTakenBy(current, directoryPath, directory?.page.pageId) !== undefined
  const spaceOwned = others.some((binding) => bindingOwnsPath(binding, directoryPath))
  const sections = directory === undefined ? undefined : directorySections(directory.page.body)
  if (
    conflictingDirectory ||
    spaceOwned ||
    pageKind(recordFolders(current.wholeSet), directoryPath).kind !== "knowledge" ||
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
  const usedNames = namesTakenAt(current.wholeSet.map((record) => record.resource.path))
  const pageId = randomUUID()
  const base = spacePageSlug(title)
  let suffix = 1
  let path = `${home}/${base}.md`
  let free = freeSpacePage(others, { pageId, pagePath: path })
  while (takesName(usedNames, path) || free === undefined) {
    suffix += 1
    path = `${home}/${base}-${suffix}.md`
    free = freeSpacePage(others, { pageId, pagePath: path })
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
    point,
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
  return free
})

type EnsureSpacePage = Pick<WikiMutationMethods, "ensureSpacePage">

const withSpacePageOrDeferred = (
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
  return yield* withSpacePageOrDeferred(services.wiki, space, options.home)
})
