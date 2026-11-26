import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, withExtras, NonNegativeIntSchema } from "../../common/schema.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import {
  FOCUS_CHOICE_STATUS,
  type FocusChoice,
  type ResolveFocusChoiceResponse
} from "./contracts.js"

const identity = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1024))

const FocusChoiceTargetSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("existing"),
    session_ref: identity,
    label: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160))
  }),
  Schema.Struct({
    kind: Schema.Literal("create"),
    name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(160))
  })
])

const DecisionSchema = Schema.Literals(["continue_here", "open_target"] as const)

const focusChoiceFields = {
  choice_id: identity,
  question_id: identity,
  source_session_id: identity,
  space_id: identity,
  revision: NonNegativeIntSchema,
  target: FocusChoiceTargetSchema,
  created_at: IsoDateTimeStringSchema,
  updated_at: IsoDateTimeStringSchema
}

const SettledFocusChoiceSchema = withExtras({
  ...focusChoiceFields,
  status: Schema.Literal(FOCUS_CHOICE_STATUS.settled),
  decision: DecisionSchema,
  result_session_ref: identity,
  settled_at: IsoDateTimeStringSchema
})

export const FocusChoiceSchema: Schema.Codec<FocusChoice> = Schema.Union([
  withExtras({ ...focusChoiceFields, status: Schema.Literal(FOCUS_CHOICE_STATUS.offered) }),
  SettledFocusChoiceSchema
])

export const ResolveFocusChoiceInputSchema = Schema.Struct({
  expected_revision: NonNegativeIntSchema,
  client_id: identity,
  decision: DecisionSchema
})

export const ResolveFocusChoiceResponseSchema: Schema.Codec<ResolveFocusChoiceResponse> =
  withExtras({
    choice: SettledFocusChoiceSchema,
    session_ref: identity,
    created: Schema.Boolean
  }).check(
    Schema.makeFilter((response) =>
      response.choice.result_session_ref === response.session_ref
        ? undefined
        : "Focus choice response must match its settled Session"
    )
  )

/** @internal Compile-time check that the schema and the type agree. */
export type FocusChoiceAgrees = Assert<Agrees<typeof FocusChoiceSchema.Type, FocusChoice>>
/** @internal Compile-time check that the schema and the type agree. */
export type ResolveFocusChoiceResponseAgrees = Assert<
  Agrees<typeof ResolveFocusChoiceResponseSchema.Type, ResolveFocusChoiceResponse>
>

export const encodeResolveFocusChoiceRequestEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(ResolveFocusChoiceInputSchema)(value, {
    onExcessProperty: "error"
  }).pipe(Effect.map(JSON.stringify))
