import { IsoDateTimeStringSchema } from "@arden-hq/protocol/effect/common"
import { Effect, Schema } from "effect"

import { MergedWikiPathSchema } from "./wiki-page-history.js"
import { MAX_WIKI_CONTENT_CHARS } from "./wiki-schemas.js"
import { WikiPathSchema } from "./wiki-schemas.js"

const MAX_LINKS = 500
const MAX_SEARCH_RESULTS = 20
const MAX_CHANGE_OFFSET = 10_000
const MAX_CHANGE_ENTRIES = 200

const ActiveWikiPathSchema = WikiPathSchema.annotate({
  description: "Exact relative POSIX .md path of an active page returned by Wiki search or listing."
})

export const SearchParametersSchema = Schema.Struct({
  query: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512)).pipe(
    Schema.annotateEncoded({
      description: "What to look for: a few words, a name, a path, or an exact phrase."
    })
  ),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SEARCH_RESULTS }))
    .annotate({
      description: `Maximum matches to return, from 1 to ${MAX_SEARCH_RESULTS}. Defaults to 8.`
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(8)))
})

const ListChangesSinceSchema = Schema.String.pipe(
  Schema.annotateEncoded({
    description: "Inclusive ISO-8601 timestamp with an explicit zone."
  }),
  Schema.decodeTo(IsoDateTimeStringSchema)
)

export const ListChangesParametersSchema = Schema.Struct({
  since: ListChangesSinceSchema,
  offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_CHANGE_OFFSET }))
    .annotate({ description: "Zero-based commit offset. Defaults to 0." })
    .pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CHANGE_ENTRIES }))
    .annotate({
      description: `Maximum commits to return, from 1 to ${MAX_CHANGE_ENTRIES}. Defaults to 100.`
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(100)))
})

export const CreateDirectoryParametersSchema = Schema.Struct({
  path: Schema.NonEmptyString.check(Schema.isMaxLength(4_096)).annotate({
    description:
      "Relative POSIX directory path without a trailing slash, such as 'people' or 'projects/research'."
  }),
  body: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS)).annotate({
    description:
      "Complete Markdown contract containing exact ## Purpose, ## Producers, ## Consumers, ## Boundaries, and ## Retention headings with nonempty sections. Add ## Records to describe filenames, dates/timezone, source pointers and lookup conventions."
  })
})

export const LinksParametersSchema = Schema.Struct({
  path: MergedWikiPathSchema,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LINKS }))
    .annotate({
      description: `Maximum links to return in each list (outgoing and backlinks), from 1 to ${MAX_LINKS}. Defaults to 100.`
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(100)))
})

export const PatchParametersSchema = Schema.Struct({
  path: ActiveWikiPathSchema,
  old_text: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS)).annotate({
    description: "Exact current body text to replace. It must occur exactly once."
  }),
  new_text: Schema.String.check(Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS)).annotate({
    description: "Literal replacement text. Empty removes the matched text."
  })
})

export const MoveParametersSchema = Schema.Struct({
  path: ActiveWikiPathSchema,
  new_path: Schema.NonEmptyString.check(Schema.isMinLength(4), Schema.isMaxLength(4_096)).annotate({
    description:
      "New relative POSIX .md path. Page identity, title, aliases, metadata, and body stay unchanged."
  })
})
