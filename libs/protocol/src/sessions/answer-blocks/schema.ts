import { Effect, Schema } from "effect"
import { NonNegativeIntSchema, withExtras } from "../../common/schema.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import type { AnswerBlockStates, SavedAnswerBlock } from "./contracts.js"

const AnswerBlockValuesSchema = Schema.Record(Schema.String, Schema.Json)

export const SavedAnswerBlockSchema: Schema.Codec<SavedAnswerBlock> = withExtras({
  message_id: Schema.NonEmptyString,
  block_index: NonNegativeIntSchema,
  state: AnswerBlockValuesSchema
})

export const AnswerBlockStatesSchema: Schema.Codec<AnswerBlockStates> = withExtras({
  blocks: Schema.Array(SavedAnswerBlockSchema)
})

export const SaveAnswerBlockInputSchema = Schema.Struct({ state: AnswerBlockValuesSchema })

/** @internal Compile-time check that the schema and the type agree. */
export type SavedAnswerBlockAgrees = Assert<
  Agrees<typeof SavedAnswerBlockSchema.Type, SavedAnswerBlock>
>

export const encodeSaveAnswerBlockRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(SaveAnswerBlockInputSchema)(value, {
    onExcessProperty: "error"
  }).pipe(Effect.map(JSON.stringify))
