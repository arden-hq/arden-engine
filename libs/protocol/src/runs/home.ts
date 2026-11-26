import { Effect, Schema } from "effect"

export const HomePresenceInputSchema = Schema.Struct({
  client_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  sequence: Schema.Natural,
  active: Schema.Boolean
})
export type HomePresenceInput = typeof HomePresenceInputSchema.Type
export const HomePresenceResponseSchema = Schema.Struct({ ok: Schema.Literal(true) })
export const encodeHomePresenceEffect = (
  value: unknown
): Effect.Effect<string, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(HomePresenceInputSchema)(value, { onExcessProperty: "error" }).pipe(
    Effect.map(JSON.stringify)
  )
