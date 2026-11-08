import { Effect, Schema } from "effect"

export class JsonColumnError extends Schema.TaggedError<JsonColumnError>()("JsonColumnError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

const jsonString = Schema.toCodecJson(Schema.String)

export const decodeJson = Effect.fn("SqliteJson.decodeJson")(function* <S extends Schema.Top>(
  schema: S,
  value: unknown
): Effect.fn.Return<S["Type"], JsonColumnError, S["DecodingServices"]> {
  const text = yield* Schema.decodeUnknownEffect(jsonString)(value).pipe(
    Effect.mapError(
      (cause) =>
        new JsonColumnError({
          operation: "decode_json",
          message: "SQLite JSON column is not a string",
          cause
        })
    )
  )
  const parsed = yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (cause) =>
      new JsonColumnError({
        operation: "decode_json",
        message: "SQLite JSON column is not valid JSON",
        cause
      })
  })
  return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
    Effect.mapError(
      (cause) =>
        new JsonColumnError({
          operation: "decode_json",
          message: "SQLite JSON column does not match its domain schema",
          cause
        })
    )
  )
})

export const encodeJson = Effect.fn("SqliteJson.encodeJson")(function* <S extends Schema.Top>(
  schema: S,
  value: S["Type"]
): Effect.fn.Return<string, JsonColumnError, S["EncodingServices"]> {
  const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(schema))(value).pipe(
    Effect.mapError(
      (cause) =>
        new JsonColumnError({
          operation: "encode_json",
          message: "Value does not match its domain schema",
          cause
        })
    )
  )
  return yield* Effect.try({
    try: () => JSON.stringify(encoded),
    catch: (cause) =>
      new JsonColumnError({
        operation: "encode_json",
        message: "Value could not be serialized as JSON",
        cause
      })
  })
})

export const decodeWith = <S extends Schema.Top, E>(
  schema: S,
  value: unknown,
  onError: (cause: Schema.SchemaError) => E
): Effect.Effect<S["Type"], E, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(onError)
  )

export const decodeJsonWith = <S extends Schema.Top, E>(
  schema: S,
  value: unknown,
  onError: (cause: JsonColumnError) => E
): Effect.Effect<S["Type"], E, S["DecodingServices"]> =>
  decodeJson(schema, value).pipe(Effect.mapError(onError))

export const encodeJsonWith = <S extends Schema.Top, E>(
  schema: S,
  value: S["Type"],
  onError: (cause: JsonColumnError) => E
): Effect.Effect<string, E, S["EncodingServices"]> =>
  encodeJson(schema, value).pipe(Effect.mapError(onError))
