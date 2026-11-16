import {
  ManagedFileRepository,
  managedFileRepositoryNodeLayer,
  type ManagedFileRepositoryOptions
} from "@arden-hq/revisions/effect"
import { Context, Effect, Layer, Scope } from "effect"

import { SpaceStore } from "../persistence/spaces/store.js"
import { Diagnostics } from "../runtime/diagnostics.js"
import { ServerLifecycle } from "../runtime/lifecycle.js"
import { makeWikiCaptureMethods, type WikiCaptureMethods } from "./capture.js"
import {
  makeWikiContentStepMethods,
  type WikiContentStep,
  type WikiContentStepMethods
} from "./content-steps.js"
import { mapRevisionError, WikiError, wikiError } from "./errors.js"
import { makeWikiForgetMethods, type WikiForgetMethods } from "./forgotten.js"
import { createRulesPage, initializeWikiFoundation } from "./foundation.js"
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
import { makeWikiChanges } from "./page-change.js"
import { makeOutsideEdits, type OutsideEditCheck, type OutsideEditState } from "./outside-edits.js"
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
  WikiImportMethods &
  WikiForgetMethods & {
    readonly publishChanges: () => Effect.Effect<{ readonly queued: number }, WikiError>
    /** Makes the owner's rules page from the rules file it replaces. */
    readonly createRulesPage: (body: string) => Effect.Effect<void, WikiError>
    readonly checkOutsideEdits: () => Effect.Effect<OutsideEditCheck, WikiError>
    /** Where a page whose file was changed outside Arden stands, as of the last check. */
    readonly outsideEditState: (path: string) => OutsideEditState | undefined
    readonly prepareMaintenance: (
      input: WikiMaintenancePrepareInput
    ) => Effect.Effect<WikiMaintenancePreparation, WikiError>
  }

export class Wiki extends Context.Service<Wiki, WikiShape>()("@arden-hq/server/wiki/Wiki") {}

const make = Effect.fn("Wiki.make")(function* (
  options: WikiRepositoryOptions
): Effect.fn.Return<Wiki["Service"], WikiError, Scope.Scope | WikiChangeSink | SpaceStore> {
  const diagnostics = yield* Diagnostics
  const lifecycle = yield* ServerLifecycle
  yield* diagnostics.startupPhase("wiki_open_started")
  const changeSink = yield* WikiChangeSink
  const spaces = yield* SpaceStore
  const repository = yield* Layer.build(
    managedFileRepositoryNodeLayer({
      ...options,
      onOpenPhase: (phase) => Effect.runSync(diagnostics.startupPhase(phase))
    })
  ).pipe(Effect.map(Context.get(ManagedFileRepository)), Effect.mapError(mapRevisionError("open")))
  yield* diagnostics.startupPhase("wiki_repository_opened")
  yield* initializeWikiFoundation({ repository, spaces }, options)
  yield* diagnostics.startupPhase("wiki_foundation_ready")

  const publishChanges = yield* makeWikiPublisher(repository, changeSink, spaces)
  const publishSavedChanges = () =>
    publishChanges().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Saved Wiki changes await event publication", cause)
      )
    )
  const listing = makeWikiListingMethods(repository)
  const outsideEdits = makeOutsideEdits({ repository, spaces, snapshot: listing.snapshot })
  const notifyAfter =
    <Args extends readonly unknown[], Result>(
      operation: (...args: Args) => Effect.Effect<Result, WikiError>
    ) =>
    (...args: Args) =>
      operation(...args).pipe(
        Effect.mapError(outsideEdits.explain),
        Effect.tap(publishSavedChanges)
      )

  const changes = makeWikiChanges({ repository, spaces }, listing.read)
  const mutations = makeWikiMutationMethods(changes, spaces)
  const restores = makeWikiRestoreMethods(repository, changes)
  const capture = makeWikiCaptureMethods(repository)
  const rename = makeWikiRenameMethods(repository, changes)
  const imports = makeWikiImportMethods(changes)
  const contentSteps = makeWikiContentStepMethods(repository, changes)
  const forgetting = makeWikiForgetMethods(changes)

  yield* diagnostics.startupPhase("wiki_ready")
  return Wiki.of({
    ...listing,
    ...makeWikiHistoryMethods(repository, listing.snapshot),
    ...makeWikiChangeMethods(repository),
    publishChanges,
    createRulesPage: notifyAfter((body: string) => createRulesPage({ repository, spaces }, body)),
    checkOutsideEdits: outsideEdits.check,
    outsideEditState: outsideEdits.state,
    prepareMaintenance: makeWikiMaintenanceMethods(repository).prepare,
    create: notifyAfter(mutations.create),
    createDirectory: notifyAfter(mutations.createDirectory),
    ensureSpacePage: notifyAfter(mutations.ensureSpacePage),
    ensureSpacePages: notifyAfter(mutations.ensureSpacePages),
    restoreSpace: (spaceId) =>
      mutations.restoreSpace(spaceId).pipe(Effect.tap(publishSavedChanges)),
    publishReport: notifyAfter(mutations.publishReport),
    update: notifyAfter(mutations.update),
    archive: notifyAfter(mutations.archive),
    mergeInto: notifyAfter(mutations.mergeInto),
    restore: notifyAfter(restores.restore),
    contentToRestore: restores.contentToRestore,
    restoreArchived: notifyAfter(restores.restoreArchived),
    importReferencePages: notifyAfter(imports.importReferencePages),
    planForget: forgetting.planForget,
    forget: notifyAfter(forgetting.forget),
    planUndoForget: forgetting.planUndoForget,
    undoForget: notifyAfter(forgetting.undoForget),
    applyContentStep: <E>(step: WikiContentStep<E>) =>
      lifecycle.isAccepting()
        ? contentSteps.applyContentStep(step).pipe(
            Effect.mapError((error) =>
              error instanceof WikiError ? outsideEdits.explain(error) : error
            ),
            Effect.tap(publishSavedChanges)
          )
        : wikiError(
            "update",
            "blocked",
            `Memory content step ${step.name} runs only after the server is ready`
          ),
    finalizeCaptureBatch: capture.finalizeCaptureBatch,
    hasCaptureReceipt: capture.hasCaptureReceipt,
    planRename: rename.planRename,
    rename: notifyAfter(rename.rename)
  })
})

export const wikiLayer = (
  options: WikiRepositoryOptions
): Layer.Layer<Wiki, WikiError, WikiChangeSink | SpaceStore> => Layer.effect(Wiki, make(options))
