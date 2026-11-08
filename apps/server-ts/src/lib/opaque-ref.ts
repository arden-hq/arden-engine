import { Option, Schema } from "effect"

export const encodeOpaque = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url")

/**
 * The value an opaque reference holds, checked against `schema`; none when the
 * text is not exactly what `encodeOpaque` writes (base64url ignores stray
 * characters, so a mangled reference must not decode to some other valid one)
 * or does not fit the schema.
 */
export const decodeOpaque = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  text: string
): Option.Option<S["Type"]> => {
  const json = Buffer.from(text, "base64url").toString("utf8")
  if (Buffer.from(json, "utf8").toString("base64url") !== text) return Option.none()
  return Schema.decodeUnknownOption(Schema.fromJsonString(schema))(json)
}
