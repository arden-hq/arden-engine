import { WIKI_PAGE_LIFECYCLE } from "@arden-hq/protocol/wiki"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import type {
  FreeSpacePage,
  PersistedSpace,
  SpaceStore,
  SpaceStoreError
} from "../persistence/spaces/store.js"
import {
  PAGE_KIND,
  DIRECTORY_CONTRACT_HEADINGS,
  directorySections,
  pageKind,
  recordFolders
} from "./collections.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "./authority.js"
import { createPage } from "./commit.js"
import { wikiError, type WikiError } from "./errors.js"
import type { WikiChangeWriter, WikiChanges, WikiPlan } from "./page-change.js"
import { formatWikiPage, namesTakenAt, parseWikiPage, takesName } from "./page.js"
import { nameTakenBy, type Snapshot } from "./snapshot.js"
import {
  SPACE_PAGE_PLAN,
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

const SPACE_PAGE_HOME = { projects: "projects", areas: "areas" } as const

export interface WikiSpacePageInput {
  readonly spaceId: string
  readonly home?: (typeof SPACE_PAGE_HOME)[keyof typeof SPACE_PAGE_HOME]
}

export const SPACE_PAGE_ENSURED = { kept: "kept", rebound: "rebound", created: "created" } as const

export type SpacePageEnsured =
  | {
      readonly kind: typeof SPACE_PAGE_ENSURED.kept | typeof SPACE_PAGE_ENSURED.rebound
      readonly space: PersistedSpace
    }
  | {
      readonly kind: typeof SPACE_PAGE_ENSURED.created
      readonly space: PersistedSpace
      readonly created: { readonly pageId: string; readonly path: string }
    }

const storageError = (message: string) => (cause: unknown) =>
  wikiError("create", "storage", message, { cause })

const spacePageWriter = (spaceId: string, operation: "create" | "restore"): WikiChangeWriter => ({
  operation,
  actor: "user:space",
  origin: { kind: "space_page" },
  authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
  reason: `attach Memory page to Space ${spaceId}`
})

export const ensureWikiSpacePage = Effect.fn("Wiki.ensureSpacePage")(function* (
  changes: WikiChanges,
  spaces: SpaceStore["Service"],
  input: WikiSpacePageInput
): Effect.fn.Return<SpacePageEnsured | undefined, WikiError> {
  const space = yield* spaces
    .get(input.spaceId)
    .pipe(Effect.mapError(storageError("Could not read the Space")))
  if (space === null) return undefined
  const { value: plan } = yield* changes.change(
    spacePageWriter(space.space_id, "create"),
    Effect.fn("Wiki.planSpacePage")(function* (current): Effect.fn.Return<
      WikiPlan<{
        readonly kind: (typeof SPACE_PAGE_PLAN)[keyof typeof SPACE_PAGE_PLAN]
        readonly page: FreeSpacePage
      }>,
      WikiError
    > {
      const others = (yield* activeSpaceBindings(spaces).pipe(
        Effect.mapError(storageError("Could not read the Spaces' Memory pages"))
      )).filter((binding) => binding.space_id !== space.space_id)
      const plan = planSpacePage(current.pages, space, others)
      return plan.kind === SPACE_PAGE_PLAN.create
        ? yield* createSpacePage(current, others, {
            title: space.name,
            home: input.home ?? SPACE_PAGE_HOME.areas
          })
        : { writes: [], value: plan }
    })
  )
  if (plan.kind === SPACE_PAGE_PLAN.keep) return { kind: SPACE_PAGE_ENSURED.kept, space }
  const bound = yield* spaces
    .bindPage(space.space_id, plan.page)
    .pipe(Effect.mapError(storageError("Could not bind the Space's page")))
  if (bound === null) return undefined
  return plan.kind === SPACE_PAGE_PLAN.rebind
    ? { kind: "rebound", space: bound }
    : {
        kind: SPACE_PAGE_ENSURED.created,
        space: bound,
        created: { pageId: plan.page.pageId, path: plan.page.pagePath }
      }
})

export const logNoSpacePage = (
  spaceId: string,
  error: WikiError
): Effect.Effect<void, never, never> =>
  Effect.logWarning("A Space has no Memory page; the next start tries again", {
    spaceId,
    reason: error.reason,
    message: error.message
  })

export type SpaceRestore = {
  readonly kind: SpacePageEnsured["kind"] | "pageless"
  readonly space: PersistedSpace
}

export const restoreWikiSpace = Effect.fn("Wiki.restoreSpace")(function* (
  changes: WikiChanges,
  spaces: SpaceStore["Service"],
  spaceId: string
): Effect.fn.Return<SpaceRestore | null, WikiError | SpaceStoreError> {
  const space = yield* spaces.get(spaceId, true)
  if (space === null || space.archived_at === null) return null
  const bindings = yield* activeSpaceBindings(spaces)
  const plan = yield* changes.preview(spacePageWriter(spaceId, "restore"), (current) =>
    Effect.succeed({ writes: [], value: planSpacePage(current.pages, space, bindings) })
  )
  if (plan.kind !== SPACE_PAGE_PLAN.create) {
    const restored = yield* spaces.restore(spaceId, plan.page)
    return restored === null
      ? null
      : {
          kind:
            plan.kind === SPACE_PAGE_PLAN.keep
              ? SPACE_PAGE_ENSURED.kept
              : SPACE_PAGE_ENSURED.rebound,
          space: restored
        }
  }
  const restored = yield* spaces.restore(spaceId, null)
  if (restored === null) return null
  return yield* ensureWikiSpacePage(changes, spaces, { spaceId }).pipe(
    Effect.map((ensured): SpaceRestore => ensured ?? { kind: "pageless", space: restored }),
    Effect.catch((error) =>
      logNoSpacePage(spaceId, error).pipe(
        Effect.as<SpaceRestore>({ kind: "pageless", space: restored })
      )
    )
  )
})

const createSpacePage = Effect.fn("Wiki.createSpacePage")(function* (
  current: Snapshot,
  others: ReadonlyArray<SpaceBinding>,
  input: {
    readonly title: string
    readonly home: (typeof SPACE_PAGE_HOME)[keyof typeof SPACE_PAGE_HOME]
  }
): Effect.fn.Return<
  WikiPlan<{ readonly kind: "create"; readonly page: FreeSpacePage }>,
  WikiError
> {
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
    pageKind(recordFolders(current.wholeSet), directoryPath).kind !== PAGE_KIND.knowledge ||
    (directory !== undefined &&
      (directory.page.lifecycle !== WIKI_PAGE_LIFECYCLE.active ||
        DIRECTORY_CONTRACT_HEADINGS.some((heading) => !sections?.get(heading))))
  ) {
    return yield* wikiError(
      "create",
      "blocked",
      `The ${home} folder must be an active, unowned collection with a valid folder contract`
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
    title: home === SPACE_PAGE_HOME.areas ? "Areas" : "Projects",
    aliases: [],
    lifecycle: "active",
    redirectTo: null,
    metadata: {},
    body: `# ${home === SPACE_PAGE_HOME.areas ? "Areas" : "Projects"}

## Purpose

${home === SPACE_PAGE_HOME.areas ? "Ongoing responsibilities, practices and Space context." : "Finite outcomes and their specific context, decisions and state."}

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
  return {
    writes: [
      ...(directory === undefined
        ? [createPage(directoryId, directoryPath, directoryContent)]
        : []),
      createPage(pageId, path, content)
    ],
    value: { kind: "create" as const, page: free }
  }
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
