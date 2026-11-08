import type { AnswerBlockState } from "@arden-hq/answer-ui/state"
import { Context, Effect, Schema } from "effect"
import { storeErrorFields } from "../errors.js"
import type { JsonObject } from "../json.js"

export class AnswerBlockStoreError extends Schema.TaggedError<AnswerBlockStoreError>()(
  "AnswerBlockStoreError",
  {
    ...storeErrorFields({
      operations: ["list", "save"],
      reasons: ["invalid", "not_found", "corrupt", "storage"]
    }),
    sessionId: Schema.optionalKey(Schema.NonEmptyString)
  }
) {}

export interface SavedAnswerBlockRecord {
  readonly messageId: string
  readonly blockIndex: number
  readonly state: JsonObject
}

export class AnswerBlockStore extends Context.Service<
  AnswerBlockStore,
  {
    readonly list: (
      sessionId: string
    ) => Effect.Effect<ReadonlyArray<SavedAnswerBlockRecord>, AnswerBlockStoreError>
    readonly forMessage: (
      sessionId: string,
      messageId: string
    ) => Effect.Effect<ReadonlyMap<number, JsonObject>, AnswerBlockStoreError>
    readonly save: (input: {
      readonly sessionId: string
      readonly messageId: string
      readonly blockIndex: number
      readonly state: AnswerBlockState
    }) => Effect.Effect<SavedAnswerBlockRecord, AnswerBlockStoreError>
  }
>()("@arden-hq/server/persistence/answer-blocks/AnswerBlockStore") {}
