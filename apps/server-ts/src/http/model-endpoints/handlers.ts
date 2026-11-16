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
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

import { WikiEmbeddingIndex } from "../../embedding/wiki-index.js"
import { ModelEndpoints, type ModelEndpointsError } from "../../models/endpoints/service.js"
import { ArdenApi } from "../api.js"

const failed = (
  error: ModelEndpointsError
): Effect.Effect<never, HttpApiError.UnprocessableEntity | HttpApiError.InternalServerError> =>
  error.reason === "invalid"
    ? Effect.fail(new HttpApiError.UnprocessableEntity({}))
    : Effect.logWarning("Model endpoint request failed", error).pipe(
        Effect.andThen(Effect.fail(new HttpApiError.InternalServerError({})))
      )

/** A draft of the wrong kind (a model server's sent to `search`) is unprocessable, as a format of the wrong kind is. */
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
        (status) => status.state !== "idle" && status.modelId === SEARCH_ENDPOINT_MODEL_ID
      ),
      Effect.orElseSucceed(() => false)
    )
    const followSearchChange = Effect.fn("ModelEndpoints.followSearchChange")(function* (
      control: "resume" | "off"
    ) {
      if (!(yield* searchUsesEndpoint)) return
      yield* embeddings
        .control(control === "off" ? { kind: "off", keepIndex: false } : { kind: "resume" })
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
      .handle("save", ({ params, payload }) => {
        const kind = params.kind
        if (kind === "chat")
          return chatDraftOf(payload).pipe(
            Effect.flatMap((draft) => endpoints.saveChat(draft).pipe(Effect.catch(failed))),
            Effect.map(chatEndpointSaveResponse)
          )
        return draftOf(payload).pipe(
          Effect.flatMap((draft) => endpoints.save(kind, draft).pipe(Effect.catch(failed))),
          Effect.tap((result) =>
            result.result === "saved" && kind === "search"
              ? followSearchChange("resume")
              : Effect.void
          ),
          Effect.map(modelEndpointSaveResponse)
        )
      })
      .handle("remove", ({ params }) => {
        const kind = params.kind
        if (kind === "chat")
          return endpoints
            .removeChat()
            .pipe(Effect.map(modelEndpointsResponse), Effect.catch(failed))
        return (kind === "search" ? followSearchChange("off") : Effect.void).pipe(
          Effect.andThen(endpoints.remove(kind)),
          Effect.map(modelEndpointsResponse),
          Effect.catch(failed)
        )
      })
      .handle("check", ({ params, payload }) => {
        const kind = params.kind
        if (kind === "chat")
          return chatDraftOf(payload).pipe(
            Effect.flatMap((draft) => endpoints.checkChat(draft).pipe(Effect.catch(failed))),
            Effect.map(chatEndpointCheckResponse)
          )
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
