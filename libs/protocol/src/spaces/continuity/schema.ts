import { Effect, Schema } from "effect"
import { ContinuitySourceCursorSchema } from "../../chat/communication-schema.js"
import {
  IsoDateTimeStringSchema,
  withExtras,
  NonNegativeIntSchema,
  PositiveIntSchema
} from "../../common/schema.js"
import type { SpaceContinuitySeenState, SpaceContinuityStateResponse } from "./contracts.js"

const IdentifierSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))

export const SpaceContinuitySeenStateSchema: Schema.Codec<SpaceContinuitySeenState> = withExtras({
  state_version: NonNegativeIntSchema,
  seen_through: ContinuitySourceCursorSchema,
  acknowledged_at: Schema.NullOr(IsoDateTimeStringSchema)
})

export const SpaceContinuityStateResponseSchema: Schema.Codec<SpaceContinuityStateResponse> =
  withExtras({
    seen: SpaceContinuitySeenStateSchema
  })

const RenderedContinuityRecordSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("arrival"), arrival_id: IdentifierSchema }),
  Schema.Struct({
    kind: Schema.Literal("question"),
    question_id: IdentifierSchema,
    revision: PositiveIntSchema
  })
]).pipe(Schema.toTaggedUnion("kind"))

export const AcknowledgeSpaceContinuityRequestSchema = Schema.Struct({
  expected_state_version: NonNegativeIntSchema,
  rendered: Schema.Array(RenderedContinuityRecordSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
    Schema.makeFilter((records) => {
      const keys = records.map((record) => {
        switch (record.kind) {
          case "arrival":
            return `arrival:${record.arrival_id}`
          case "question":
            return `question:${record.question_id}:${record.revision}`
        }
      })
      return new Set(keys).size === keys.length ? undefined : "contains duplicate rendered records"
    })
  )
})

export const encodeAcknowledgeSpaceContinuityRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(AcknowledgeSpaceContinuityRequestSchema)(value, {
    onExcessProperty: "error"
  }).pipe(Effect.map(JSON.stringify))
