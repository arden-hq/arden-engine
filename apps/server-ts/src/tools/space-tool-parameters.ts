import { Effect, Schema } from "effect"

import { MAX_WIKI_CONTENT_CHARS } from "./wiki-schemas.js"

const MAX_PAGE_LINES = 4_000

export const OptionalSpaceIdSchema = Schema.optionalKey(
  Schema.NonEmptyString.check(Schema.isMaxLength(512)).annotate({
    description: "Exact space_id from space_list. Omit to use the current session's Space."
  })
)

export const SpacePageReadParametersSchema = Schema.Struct({
  space_id: OptionalSpaceIdSchema,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
    .annotate({
      description: "One-based first body line to return. Defaults to 1."
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_LINES }))
    .annotate({
      description: `Maximum body lines to return, from 1 to ${MAX_PAGE_LINES}. Defaults to 500.`
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(500)))
})

export const SpacePagePatchParametersSchema = Schema.Struct({
  space_id: OptionalSpaceIdSchema,
  old_text: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS)).annotate({
    description: "Exact current body text to replace. It must occur exactly once."
  }),
  new_text: Schema.String.check(Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS)).annotate({
    description: "Literal replacement text. Empty removes the matched text."
  })
})

export const SpacePageWriteParametersSchema = Schema.Struct({
  space_id: OptionalSpaceIdSchema,
  body: Schema.String.check(Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS)).annotate({
    description: "Complete replacement Markdown body. Page identity and metadata stay unchanged."
  })
})
