import { Schema } from "effect"
import { IsoDateTimeStringSchema } from "../common/schema.js"

const SourceInput = Schema.Struct({
  ref: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  provider: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  kind: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  href: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096)))
})
export const SourceTitleRequestSchema = Schema.Struct({
  sources: Schema.Array(SourceInput).check(Schema.isMaxLength(50))
})
const Identity = {
  ref: Schema.String,
  provider: Schema.String,
  kind: Schema.String
}
export const SourceMetadataSchema = Schema.Union([
  Schema.Struct({
    ...Identity,
    status: Schema.Literal("resolved"),
    title: Schema.NonEmptyString,
    at: Schema.optionalKey(IsoDateTimeStringSchema),
    href: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({
    ...Identity,
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals(["not_connected", "not_found", "unsupported", "unavailable", "unnamed"])
  })
])
export const SourceTitleResponseSchema = Schema.Struct({
  sources: Schema.Array(SourceMetadataSchema)
})
export type SourceMetadataInput = typeof SourceInput.Type
export type SourceMetadata = typeof SourceMetadataSchema.Type
