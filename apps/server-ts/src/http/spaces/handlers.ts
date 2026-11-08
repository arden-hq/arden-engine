import { SessionStore } from "../../persistence/sessions/store.js"
import type { Space, UpdateSpaceInput } from "@arden-hq/protocol/spaces"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import {
  StructuredCompletion,
  StructuredCompletionError
} from "../../models/structured-completion.js"
import { SpaceStore, SpaceStoreError, type PersistedSpace } from "../../persistence/spaces/store.js"
import { SummaryStore } from "../../persistence/summaries/store.js"
import { makeSpaceInstructions } from "../../assist/space-instructions.js"
import { Wiki } from "../../wiki/service.js"
import { WikiError } from "../../wiki/errors.js"
import { ArdenApi } from "../api.js"
import { ChatStop } from "../../chat/chat-stop.js"
import {
  completionErrorToHttp,
  failStore,
  orNotFound,
  storeErrorToHttp,
  wikiErrorToHttp
} from "../errors.js"

const lifecycleError = (error: SpaceStoreError | WikiError) =>
  error._tag === "SpaceStoreError" ? storeErrorToHttp(error) : wikiErrorToHttp(error)

const publicSpace = (space: PersistedSpace): Space => ({
  inference: space.inference,
  space_id: space.space_id,
  name: space.name,
  instructions: space.instructions,
  instructions_source: space.instructions_source,
  page_path: space.page_path,
  mark: space.mark,
  created_at: space.created_at,
  updated_at: space.updated_at,
  archived_at: space.archived_at
})

export const SpaceHandlers = HttpApiBuilder.group(
  ArdenApi,
  "spaces",
  Effect.fn("SpaceHandlers")(function* (handlers) {
    const sessions = yield* SessionStore
    const store = yield* SpaceStore
    const chatStop = yield* ChatStop
    const summaries = yield* SummaryStore
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
      stop: boolean | "true" | "false" = false
    ) {
      const ended = yield* chatStop
        .endSpace({ spaceId, stop: stop === true || stop === "true" })
        .pipe(
          Effect.mapError((error) => {
            if (error._tag !== "SpaceStoreError") return new HttpApiError.InternalServerError({})
            if (error.reason === "conflict") return { detail: error.message, chats: [] }
            return storeErrorToHttp(error)
          })
        )
      switch (ended.kind) {
        case "ended":
          return { status: "archived" as const, space_id: spaceId }
        case "not_found":
          return yield* new HttpApiError.NotFound({})
        case "running":
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
      .handle("overviewHistory", ({ params, query }) =>
        summaries
          .spaceHistory(params.spaceId, query.after ?? 0, query.limit ?? 50)
          .pipe(Effect.catch(failStore))
      )
      .handle("list", () =>
        store.list().pipe(
          Effect.map((spaces) => ({ spaces: spaces.map(publicSpace) })),
          Effect.mapError(() => new HttpApiError.InternalServerError({}))
        )
      )
      .handle("create", ({ payload }) =>
        store.create(payload).pipe(Effect.map(publicSpace), Effect.catch(failStore))
      )
      .handle("update", ({ params, payload }) => updateSpace(params.spaceId, payload))
      .handle(
        "createPage",
        Effect.fn("SpaceHandlers.createPage")(function* ({ params }) {
          const current = yield* store
            .get(params.spaceId)
            .pipe(Effect.mapError(lifecycleError), Effect.flatMap(orNotFound))
          if (current.page_path !== null) return yield* new HttpApiError.Conflict({})
          const page = yield* wiki
            .createSpacePage({ spaceId: params.spaceId, title: current.name })
            .pipe(Effect.mapError(lifecycleError))
          const bound = yield* store
            .bindPage(params.spaceId, page.pageId, page.path)
            .pipe(Effect.mapError(lifecycleError), Effect.flatMap(orNotFound))
          return publicSpace(bound)
        })
      )
      .handle("detachPage", ({ params }) =>
        store
          .detachPage(params.spaceId)
          .pipe(
            Effect.mapError(lifecycleError),
            Effect.flatMap(orNotFound),
            Effect.map(publicSpace)
          )
      )
      .handle("restore", ({ params }) =>
        store
          .restore(params.spaceId)
          .pipe(
            Effect.mapError(lifecycleError),
            Effect.flatMap(orNotFound),
            Effect.map(publicSpace)
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
          Effect.mapError(() => new HttpApiError.InternalServerError({}))
        )
      )
      .handle("conversation", ({ params }) =>
        sessions.ensureSpaceConversation(params.spaceId).pipe(
          Effect.map((sessionId) => ({ session_id: sessionId })),
          Effect.catch(failStore)
        )
      )
      .handle("detail", ({ params }) =>
        store.detail(params.spaceId).pipe(Effect.catch(failStore), Effect.flatMap(orNotFound))
      )
      .handle("archive", ({ params, query }) => archiveSpace(params.spaceId, query.stop))
  })
)
