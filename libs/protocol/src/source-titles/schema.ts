import { Schema } from "effect"
import { IsoDateTimeStringSchema } from "../common/schema.js"

export const SOURCE_INPUT = { ref: "ref", place: "place" } as const
export const SOURCE_LINK = { linked: "linked", unlinked: "unlinked" } as const
export const SOURCE_DATE = { dated: "dated", undated: "undated" } as const

const SourceLinkSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(SOURCE_LINK.linked),
    href: Schema.String.check(Schema.isMaxLength(4096))
  }),
  Schema.Struct({ kind: Schema.Literal(SOURCE_LINK.unlinked) })
])
const SourceRefSchema = Schema.NonEmptyString.check(Schema.isMaxLength(4096))
const SourceInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal(SOURCE_INPUT.ref), ref: SourceRefSchema }),
  Schema.Struct({
    type: Schema.Literal(SOURCE_INPUT.place),
    ref: SourceRefSchema,
    provider: Schema.String.check(Schema.isMaxLength(64)),
    kind: Schema.String.check(Schema.isMaxLength(64)),
    title: Schema.String.check(Schema.isMaxLength(1024)),
    link: SourceLinkSchema
  })
])
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
    date: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(SOURCE_DATE.dated), at: IsoDateTimeStringSchema }),
      Schema.Struct({ kind: Schema.Literal(SOURCE_DATE.undated) })
    ]),
    link: SourceLinkSchema
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
export type SourceLink = typeof SourceLinkSchema.Type
export type SourceMetadataInput = typeof SourceInput.Type
export type SourceMetadata = typeof SourceMetadataSchema.Type
