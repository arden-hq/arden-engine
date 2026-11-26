import { STORE_REASON } from "../../persistence/errors.js"
import { MODEL_ENDPOINT_KIND, MODEL_ENDPOINT_RESULT } from "@arden-hq/protocol/model-endpoints"
import {
  chatEndpointCheckResponse,
  chatEndpointSaveResponse,
  decisionStatusResponse,
  decodeChatEndpointDraftEffect,
  decodeModelEndpointDraftEffect,
  modelEndpointSaveResponse,
  modelEndpointsResponse
} from "@arden-hq/protocol/effect/model-endpoints"
import { SEARCH_ENDPOINT_MODEL_ID } from "@arden-hq/protocol/model-endpoints"
import { isEmbeddingSearchStopped } from "@arden-hq/protocol/embeddings"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

import { EMBEDDING_CONTROL } from "../../embedding/index-plan.js"
import { WikiEmbeddingIndex } from "../../embedding/wiki-index.js"
import { ModelEndpoints, type ModelEndpointsError } from "../../models/endpoints/service.js"
import { ArdenApi } from "../api.js"

const failed = (
  error: ModelEndpointsError
): Effect.Effect<
  never,
  HttpApiError.UnprocessableEntity | HttpApiError.NotFound | HttpApiError.InternalServerError
> => {
  switch (error.reason) {
    case STORE_REASON.invalid:
      return Effect.fail(new HttpApiError.UnprocessableEntity({}))
    case STORE_REASON.not_found:
      return Effect.fail(new HttpApiError.NotFound({}))
    case STORE_REASON.storage:
      return Effect.logWarning("Model endpoint request failed", error).pipe(
        Effect.andThen(Effect.fail(new HttpApiError.InternalServerError({})))
      )
  }
}

const draftOf = (payload: unknown) =>
  decodeModelEndpointDraftEffect(payload).pipe(
    Effect.mapError(() => new HttpApiError.UnprocessableEntity({}))
  )

const chatDraftOf = (payload: unknown) =>
  decodeChatEndpointDraftEffect(payload).pipe(
    Effect.mapError(() => new HttpApiError.UnprocessableEntity({}))
  )

export const ModelEndpointHandlers = HttpApiBuilder.group(
  ArdenApi,
  "modelEndpoints",
  Effect.fn(function* (handlers) {
    const endpoints = yield* ModelEndpoints
    const embeddings = yield* WikiEmbeddingIndex
    const searchUsesEndpoint = embeddings.status().pipe(
      Effect.map(
        (status) => !isEmbeddingSearchStopped(status) && status.modelId === SEARCH_ENDPOINT_MODEL_ID
      ),
      Effect.orElseSucceed(() => false)
    )
    const followSearchChange = Effect.fn("ModelEndpoints.followSearchChange")(function* (
      control: typeof EMBEDDING_CONTROL.resume | typeof EMBEDDING_CONTROL.off
    ) {
      if (!(yield* searchUsesEndpoint)) return
      yield* embeddings
        .control(
          control === EMBEDDING_CONTROL.off
            ? { kind: EMBEDDING_CONTROL.off, keepIndex: false }
            : { kind: EMBEDDING_CONTROL.resume }
        )
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Wiki search did not follow the endpoint change", cause)
          )
        )
    })
    return handlers
      .handle("list", () =>
        endpoints.list().pipe(Effect.map(modelEndpointsResponse), Effect.catch(failed))
      )
      .handle("addChat", ({ payload }) =>
        chatDraftOf(payload).pipe(
          Effect.flatMap((draft) =>
            endpoints.saveChat({ draft, editing: undefined }).pipe(Effect.catch(failed))
          ),
          Effect.map(chatEndpointSaveResponse)
        )
      )
      .handle("replaceChat", ({ params, payload }) =>
        chatDraftOf(payload).pipe(
          Effect.flatMap((draft) =>
            endpoints.saveChat({ draft, editing: params.id }).pipe(Effect.catch(failed))
          ),
          Effect.map(chatEndpointSaveResponse)
        )
      )
      .handle("removeChat", ({ params }) =>
        endpoints
          .removeChat(params.id)
          .pipe(Effect.map(modelEndpointsResponse), Effect.catch(failed))
      )
      .handle("checkChat", ({ payload }) =>
        chatDraftOf(payload).pipe(
          Effect.flatMap((draft) =>
            endpoints.checkChat({ draft, editing: undefined }).pipe(Effect.catch(failed))
          ),
          Effect.map(chatEndpointCheckResponse)
        )
      )
      .handle("checkChatEdit", ({ params, payload }) =>
        chatDraftOf(payload).pipe(
          Effect.flatMap((draft) =>
            endpoints.checkChat({ draft, editing: params.id }).pipe(Effect.catch(failed))
          ),
          Effect.map(chatEndpointCheckResponse)
        )
      )
      .handle("save", ({ params, payload }) => {
        const kind = params.kind
        return draftOf(payload).pipe(
          Effect.flatMap((draft) => endpoints.save(kind, draft).pipe(Effect.catch(failed))),
          Effect.tap((result) =>
            result.result === MODEL_ENDPOINT_RESULT.saved && kind === MODEL_ENDPOINT_KIND.search
              ? followSearchChange(EMBEDDING_CONTROL.resume)
              : Effect.void
          ),
          Effect.map(modelEndpointSaveResponse)
        )
      })
      .handle("remove", ({ params }) => {
        const kind = params.kind
        return (
          kind === MODEL_ENDPOINT_KIND.search
            ? followSearchChange(EMBEDDING_CONTROL.off)
            : Effect.void
        ).pipe(
          Effect.andThen(endpoints.remove(kind)),
          Effect.map(modelEndpointsResponse),
          Effect.catch(failed)
        )
      })
      .handle("check", ({ params, payload }) => {
        const kind = params.kind
        return draftOf(payload).pipe(
          Effect.flatMap((draft) => endpoints.check(kind, draft).pipe(Effect.catch(failed)))
        )
      })
      .handle("decisionStatus", () =>
        endpoints.decisionStatus().pipe(Effect.map(decisionStatusResponse), Effect.catch(failed))
      )
      .handle("decisionSource", ({ payload }) =>
        endpoints
          .setDecisionSource(payload.source)
          .pipe(Effect.map(decisionStatusResponse), Effect.catch(failed))
      )
  })
)
