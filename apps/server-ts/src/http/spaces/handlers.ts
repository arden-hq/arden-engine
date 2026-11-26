import { SessionStore } from "../../persistence/sessions/store.js"
import type { UpdateSpaceInput } from "@arden-hq/protocol/spaces"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import {
  StructuredCompletion,
  StructuredCompletionError
} from "../../models/structured-completion.js"
import { SpaceStore, SpaceStoreError } from "../../persistence/spaces/store.js"
import { publicDetail, publicSpace } from "../../persistence/spaces/public.js"
import { makeSpaceInstructions } from "../../assist/space-instructions.js"
import { Wiki } from "../../wiki/service.js"
import { WikiError } from "../../wiki/errors.js"
import { createSpaceWithPage } from "../../wiki/space-page.js"
import { ArdenApi } from "../api.js"
import { ChatStop, END_RESULT } from "../../chat/chat-stop.js"
import { STORE_REASON } from "../../persistence/errors.js"
import { queryFlag, type QueryBoolean } from "@arden-hq/protocol/common"
import {
  completionErrorToHttp,
  failInternal,
  failStore,
  orNotFound,
  storeErrorToHttp,
  wikiErrorToHttp
} from "../errors.js"

const lifecycleError = (error: SpaceStoreError | WikiError) =>
  error instanceof SpaceStoreError ? storeErrorToHttp(error) : wikiErrorToHttp(error)

export const SpaceHandlers = HttpApiBuilder.group(
  ArdenApi,
  "spaces",
  Effect.fn("SpaceHandlers")(function* (handlers) {
    const sessions = yield* SessionStore
    const store = yield* SpaceStore
    const chatStop = yield* ChatStop
    const wiki = yield* Wiki
    const completion = yield* StructuredCompletion
    const draftInstructions = makeSpaceInstructions({ completion, store, wiki })

    const updateSpace = Effect.fn("SpaceHandlers.updateSpace")(function* (
      spaceId: string,
      input: UpdateSpaceInput
    ) {
      const updated = yield* store
        .update(spaceId, input)
        .pipe(Effect.mapError(lifecycleError), Effect.flatMap(orNotFound))
      return publicSpace(updated)
    })

    const archiveSpace = Effect.fn("SpaceHandlers.archiveSpace")(function* (
      spaceId: string,
      stop: boolean | QueryBoolean = false
    ) {
      const ended = yield* chatStop.endSpace({ spaceId, stop: queryFlag(stop) }).pipe(
        Effect.mapError((error) => {
          if (!(error instanceof SpaceStoreError)) return new HttpApiError.InternalServerError({})
          if (error.reason === STORE_REASON.conflict) return { detail: error.message, chats: [] }
          return storeErrorToHttp(error)
        })
      )
      switch (ended.kind) {
        case END_RESULT.ended:
          return { status: "archived" as const, space_id: spaceId }
        case END_RESULT.not_found:
          return yield* new HttpApiError.NotFound({})
        case END_RESULT.running:
          return yield* Effect.fail({
            detail: "The Space's chats still have work running",
            chats: ended.chats
          })
      }
    })

    return handlers
      .handle("configurationHistory", ({ params, query }) =>
        store.history({ id: params.spaceId, ...query }).pipe(Effect.catch(failStore))
      )
      .handle("list", () =>
        store.list().pipe(
          Effect.map((spaces) => ({ spaces: spaces.map(publicSpace) })),
          Effect.catch(failInternal("Spaces"))
        )
      )
      .handle("create", ({ payload }) =>
        createSpaceWithPage({ spaces: store, wiki }, payload).pipe(
          Effect.map(publicSpace),
          Effect.catch(failStore)
        )
      )
      .handle("update", ({ params, payload }) => updateSpace(params.spaceId, payload))
      .handle("createPage", ({ params }) =>
        wiki.ensureSpacePage({ spaceId: params.spaceId }).pipe(
          Effect.mapError(lifecycleError),
          Effect.flatMap(orNotFound),
          Effect.map(({ space }) => publicSpace(space))
        )
      )
      .handle("restore", ({ params }) =>
        wiki.restoreSpace(params.spaceId).pipe(
          Effect.mapError(lifecycleError),
          Effect.flatMap(orNotFound),
          Effect.map(({ space }) => publicSpace(space))
        )
      )
      .handle("generateInstructions", ({ params }) =>
        draftInstructions(params.spaceId).pipe(
          Effect.mapError((error) =>
            error instanceof StructuredCompletionError
              ? completionErrorToHttp(error)
              : storeErrorToHttp(error)
          ),
          Effect.flatMap(orNotFound),
          Effect.map(publicSpace)
        )
      )
      .handle("overview", () => store.overview().pipe(Effect.catch(failStore)))
      .handle("pinned", ({ payload }) =>
        store.setPinned(payload.space_ids).pipe(
          Effect.flatMap(() => store.overview()),
          Effect.catch(failStore)
        )
      )
      .handle("archived", () =>
        store.listArchived().pipe(
          Effect.map((spaces) => ({ spaces: spaces.map(publicSpace) })),
          Effect.catch(failInternal("Spaces"))
        )
      )
      .handle("conversation", ({ params }) =>
        sessions.ensureSpaceConversation(params.spaceId).pipe(
          Effect.map((sessionId) => ({ session_id: sessionId })),
          Effect.catch(failStore)
        )
      )
      .handle("detail", ({ params }) =>
        store
          .detail(params.spaceId)
          .pipe(Effect.catch(failStore), Effect.flatMap(orNotFound), Effect.map(publicDetail))
      )
      .handle("archive", ({ params, query }) => archiveSpace(params.spaceId, query.stop))
  })
)
