import { Option, Schema } from "effect"

export const encodeOpaque = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url")

export const decodeOpaque = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  text: string
): Option.Option<S["Type"]> => {
  const json = Buffer.from(text, "base64url").toString("utf8")
  if (Buffer.from(json, "utf8").toString("base64url") !== text) return Option.none()
  return Schema.decodeUnknownOption(Schema.fromJsonString(schema))(json)
}
