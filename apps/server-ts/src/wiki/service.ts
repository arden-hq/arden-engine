import {
  ManagedFileRepository,
  managedFileRepositoryNodeLayer,
  type ManagedFileRepositoryOptions
} from "@arden-hq/revisions/effect"
import { Context, Effect, Layer, Scope } from "effect"

import { SpaceStore } from "../persistence/spaces/store.js"
import { WikiRenameStore } from "../persistence/wiki/rename-store.js"
import { Diagnostics } from "../runtime/diagnostics.js"
import { ServerLifecycle } from "../runtime/lifecycle.js"
import { makeWikiCaptureMethods, type WikiCaptureMethods } from "./capture.js"
import {
  makeWikiContentStepMethods,
  type WikiContentStep,
  type WikiContentStepMethods
} from "./content-steps.js"
import { mapRevisionError, WikiError, wikiError } from "./errors.js"
import { initializeWikiFoundation } from "./foundation.js"
import { makeWikiChangeMethods, type WikiChangeMethods } from "./change.js"
import { makeWikiHistoryMethods, type WikiHistoryMethods } from "./history.js"
import { makeWikiImportMethods, type WikiImportMethods } from "./imported.js"
import { makeWikiListingMethods, type WikiListingMethods } from "./listing.js"
import {
  makeWikiMaintenanceMethods,
  type WikiMaintenancePreparation,
  type WikiMaintenancePrepareInput
} from "./maintenance.js"
import { makeWikiMutationMethods, type WikiMutationMethods } from "./mutations.js"
import { makeWikiPublisher, WikiChangeSink } from "./publication.js"
import { makeWikiRenameMethods, type WikiRenameMethods } from "./rename.js"
import { makeWikiRestoreMethods, type WikiRestoreMethods } from "./restore.js"

export type WikiRepositoryOptions = Pick<
  ManagedFileRepositoryOptions,
  "workingRoot" | "historyRoot"
>

type WikiShape = WikiListingMethods &
  WikiMutationMethods &
  WikiRestoreMethods &
  WikiCaptureMethods &
  WikiContentStepMethods &
  WikiHistoryMethods &
  WikiChangeMethods &
  WikiRenameMethods &
  WikiImportMethods & {
    readonly publishChanges: () => Effect.Effect<{ readonly queued: number }, WikiError>
    readonly prepareMaintenance: (
      input: WikiMaintenancePrepareInput
    ) => Effect.Effect<WikiMaintenancePreparation, WikiError>
  }

export class Wiki extends Context.Service<Wiki, WikiShape>()("@arden-hq/server/wiki/Wiki") {}

const make = Effect.fn("Wiki.make")(function* (
  options: WikiRepositoryOptions
): Effect.fn.Return<
  Wiki["Service"],
  WikiError,
  Scope.Scope | WikiChangeSink | SpaceStore | WikiRenameStore
> {
  const diagnostics = yield* Diagnostics
  const lifecycle = yield* ServerLifecycle
  yield* diagnostics.startupPhase("wiki_open_started")
  const changeSink = yield* WikiChangeSink
  const spaces = yield* SpaceStore
  const renameStore = yield* WikiRenameStore
  const repository = yield* Layer.build(
    managedFileRepositoryNodeLayer({
      ...options,
      onOpenPhase: (phase) => Effect.runSync(diagnostics.startupPhase(phase))
    })
  ).pipe(Effect.map(Context.get(ManagedFileRepository)), Effect.mapError(mapRevisionError("open")))
  yield* diagnostics.startupPhase("wiki_repository_opened")
  yield* initializeWikiFoundation(repository, options)
  yield* diagnostics.startupPhase("wiki_foundation_ready")

  const publishChanges = yield* makeWikiPublisher(repository, changeSink, spaces)
  const publishSavedChanges = () =>
    publishChanges().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Saved Wiki changes await event publication", cause)
      )
    )
  const notifyAfter =
    <Args extends readonly unknown[], Result>(
      operation: (...args: Args) => Effect.Effect<Result, WikiError>
    ) =>
    (...args: Args) =>
      operation(...args).pipe(Effect.tap(publishSavedChanges))

  const listing = makeWikiListingMethods(repository)
  const mutations = makeWikiMutationMethods(repository, spaces, listing.read)
  const restores = makeWikiRestoreMethods(repository, spaces, listing.read)
  const capture = makeWikiCaptureMethods(repository, spaces, listing.read)
  const rename = makeWikiRenameMethods(repository, spaces, renameStore)
  const imports = makeWikiImportMethods(repository)
  const contentSteps = makeWikiContentStepMethods(repository)

  yield* diagnostics.startupPhase("wiki_ready")
  return Wiki.of({
    ...listing,
    ...makeWikiHistoryMethods(repository, listing.snapshot),
    ...makeWikiChangeMethods(repository),
    publishChanges,
    prepareMaintenance: makeWikiMaintenanceMethods(repository).prepare,
    observe: notifyAfter(mutations.observe),
    create: notifyAfter(mutations.create),
    createDirectory: notifyAfter(mutations.createDirectory),
    createSpacePage: notifyAfter(mutations.createSpacePage),
    publishReport: notifyAfter(mutations.publishReport),
    update: notifyAfter(mutations.update),
    archive: notifyAfter(mutations.archive),
    mergeInto: notifyAfter(mutations.mergeInto),
    restore: notifyAfter(restores.restore),
    restoreRevision: notifyAfter(restores.restoreRevision),
    restoreArchived: notifyAfter(restores.restoreArchived),
    applyCapturePatchSet: notifyAfter(capture.applyCapturePatchSet),
    importReferencePages: notifyAfter(imports.importReferencePages),
    applyContentStep: <E>(step: WikiContentStep<E>) =>
      lifecycle.isAccepting()
        ? contentSteps.applyContentStep(step).pipe(Effect.tap(publishSavedChanges))
        : wikiError(
            "update",
            "blocked",
            `Memory content step ${step.name} runs only after the server is ready`
          ),
    finalizeCaptureBatch: capture.finalizeCaptureBatch,
    hasFinalizedCaptureBatch: capture.hasFinalizedCaptureBatch,
    ...rename,
    requestRename: notifyAfter(rename.requestRename),
    acceptRename: notifyAfter(rename.acceptRename)
  })
})

export const wikiLayer = (
  options: WikiRepositoryOptions
): Layer.Layer<Wiki, WikiError, WikiChangeSink | SpaceStore | WikiRenameStore> =>
  Layer.effect(Wiki, make(options))
