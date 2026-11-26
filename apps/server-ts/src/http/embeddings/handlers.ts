import { EMBEDDING_MODEL_CHOICE } from "@arden-hq/protocol/embeddings"
import {
  decodeEmbeddingModelChoiceRequestEffect,
  embeddingStatusResponse
} from "@arden-hq/protocol/effect/embeddings"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

import {
  CONTROL_REJECTION,
  EMBEDDING_CONTROL,
  type EmbeddingControl
} from "../../embedding/index-plan.js"
import { WikiEmbeddingIndex } from "../../embedding/wiki-index.js"
import { ArdenApi } from "../api.js"
import { failInternal } from "../errors.js"

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
              rejected.reason === CONTROL_REJECTION.unknownModel
                ? new HttpApiError.UnprocessableEntity({})
                : new HttpApiError.Conflict({})
            ),
          WikiEmbeddingIndexError: (cause) => failInternal("Embedding control")(cause)
        })
      )
    return handlers
      .handle("status", () =>
        embeddings
          .status()
          .pipe(Effect.map(embeddingStatusResponse), Effect.catch(failInternal("Embeddings")))
      )
      .handle("setModel", ({ payload }) =>
        decodeEmbeddingModelChoiceRequestEffect(payload).pipe(
          Effect.mapError(() => new HttpApiError.BadRequest({})),
          Effect.flatMap((choice) =>
            control(
              choice.kind === EMBEDDING_MODEL_CHOICE.off
                ? { kind: EMBEDDING_CONTROL.off, keepIndex: choice.keepIndex }
                : { kind: EMBEDDING_CONTROL.choose, modelId: choice.modelId }
            )
          )
        )
      )
      .handle("pause", () => control({ kind: EMBEDDING_CONTROL.pause }))
      .handle("resume", () => control({ kind: EMBEDDING_CONTROL.resume }))
      .handle("cancel", () => control({ kind: EMBEDDING_CONTROL.cancel }))
  })
)
