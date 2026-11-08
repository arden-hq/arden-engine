import { Effect, Schema } from "effect"
import { IsoDateTimeStringSchema, withExtras, NonNegativeIntSchema } from "../../common/schema.js"
import type { Agrees, Assert } from "../../common/type-agreement.js"
import type { FocusChoice, ResolveFocusChoiceResponse } from "./contracts.js"

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

export const FocusChoiceSchema: Schema.Codec<FocusChoice> = withExtras({
  choice_id: identity,
  question_id: identity,
  source_session_id: identity,
  space_id: identity,
  revision: NonNegativeIntSchema,
  target: FocusChoiceTargetSchema,
  status: Schema.Literals(["offered", "settled"] as const),
  decision: Schema.NullOr(Schema.Literals(["continue_here", "open_target"] as const)),
  result_session_ref: Schema.NullOr(identity),
  created_at: IsoDateTimeStringSchema,
  updated_at: IsoDateTimeStringSchema,
  settled_at: Schema.NullOr(IsoDateTimeStringSchema)
}).check(
  Schema.makeFilter((choice) => {
    const settled =
      choice.decision !== null && choice.result_session_ref !== null && choice.settled_at !== null
    return (choice.status === "settled") === settled
      ? undefined
      : "settled Focus choices require decision, Session, and settled_at"
  })
)

export const ResolveFocusChoiceInputSchema = Schema.Struct({
  expected_revision: NonNegativeIntSchema,
  client_id: identity,
  decision: Schema.Literals(["continue_here", "open_target"] as const)
})

export const ResolveFocusChoiceResponseSchema: Schema.Codec<ResolveFocusChoiceResponse> =
  withExtras({
    choice: FocusChoiceSchema,
    session_ref: identity,
    created: Schema.Boolean
  }).check(
    Schema.makeFilter((response) =>
      response.choice.status === "settled" &&
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

export const encodeResolveFocusChoiceRequestEffect = (value: unknown) =>
  Schema.decodeUnknownEffect(ResolveFocusChoiceInputSchema)(value, {
    onExcessProperty: "error"
  }).pipe(Effect.map(JSON.stringify))
