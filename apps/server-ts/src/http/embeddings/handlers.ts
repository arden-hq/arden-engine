import {
  decodeEmbeddingModelChoiceRequestEffect,
  embeddingStatusResponse
} from "@arden-hq/protocol/effect/embeddings"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

import type { EmbeddingControl } from "../../embedding/index-plan.js"
import { WikiEmbeddingIndex } from "../../embedding/wiki-index.js"
import { ArdenApi } from "../api.js"

const internalError = () => new HttpApiError.InternalServerError({})

export const EmbeddingHandlers = HttpApiBuilder.group(
  ArdenApi,
  "embeddings",
  Effect.fn(function* (handlers) {
    const embeddings = yield* WikiEmbeddingIndex
    const control = (request: EmbeddingControl) =>
      embeddings.control(request).pipe(
        Effect.map(embeddingStatusResponse),
        Effect.catchTags({
          EmbeddingControlRejected: (rejected) =>
            Effect.fail(
              rejected.reason === "unknown_model"
                ? new HttpApiError.UnprocessableEntity({})
                : new HttpApiError.Conflict({})
            ),
          WikiEmbeddingIndexError: (cause) =>
            Effect.logWarning("Embedding control failed", cause).pipe(
              Effect.andThen(Effect.fail(internalError()))
            )
        })
      )
    return handlers
      .handle("status", () =>
        embeddings
          .status()
          .pipe(Effect.map(embeddingStatusResponse), Effect.mapError(internalError))
      )
      .handle("setModel", ({ payload }) =>
        decodeEmbeddingModelChoiceRequestEffect(payload).pipe(
          Effect.mapError(() => new HttpApiError.BadRequest({})),
          Effect.flatMap((choice) =>
            control(
              choice.kind === "off"
                ? { kind: "off", keepIndex: choice.keepIndex }
                : { kind: "choose", modelId: choice.modelId }
            )
          )
        )
      )
      .handle("pause", () => control({ kind: "pause" }))
      .handle("resume", () => control({ kind: "resume" }))
      .handle("cancel", () => control({ kind: "cancel" }))
  })
)
