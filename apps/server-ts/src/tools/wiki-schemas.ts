import { Effect, Schema } from "effect"
import { ObservationPeriodSchema } from "../wiki/observation-period.js"

const MAX_PAGE_LINES = 4_000

export const MAX_WIKI_CONTENT_CHARS = 40_000

export const WIKI_PAGE_BUDGET_CHARS = 32_000

const MAX_LIST_ENTRIES = 200

export const WikiPathSchema = Schema.NonEmptyString.check(Schema.isMaxLength(4_096)).annotate({
  description: "Exact relative POSIX .md path of the wiki page, such as 'projects/dex.md'."
})

export const ListParametersSchema = Schema.Struct({
  directory: Schema.String.check(Schema.isMaxLength(4_096))
    .annotate({
      description: "Exact wiki directory, such as 'areas'. Empty means the wiki root."
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  offset: Schema.Natural.annotate({
    description: "Zero-based entry offset from a prior list result."
  }).pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIST_ENTRIES }))
    .annotate({
      description: `Maximum entries to return, from 1 to ${MAX_LIST_ENTRIES}. Defaults to 100.`
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(100)))
})

export const ReadParametersSchema = Schema.Struct({
  path: WikiPathSchema,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
    .annotate({
      description: "One-based first line to return. Defaults to 1."
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_LINES }))
    .annotate({
      description: `Maximum lines to return, from 1 to ${MAX_PAGE_LINES}. Defaults to 500.`
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(500)))
})

export const CreateParametersSchema = Schema.Struct({
  path: Schema.NonEmptyString.check(Schema.isMinLength(4), Schema.isMaxLength(4_096)).annotate({
    description:
      "Relative POSIX .md path inside an existing wiki directory, or a root profile page named in the tool description."
  }),
  title: Schema.NonEmptyString.check(Schema.isMaxLength(4_096)).annotate({
    description: "Human-readable page title."
  }),
  body: Schema.String.check(
    Schema.isPattern(/\S/u),
    Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS)
  ).annotate({
    description:
      "Required Markdown body with useful content, not an empty or title-only placeholder."
  })
})

const PageEditSchema = Schema.Struct({
  path: WikiPathSchema,
  body: Schema.String.check(Schema.isPattern(/\S/u), Schema.isMaxLength(MAX_WIKI_CONTENT_CHARS))
    .annotate({
      description: "Complete replacement Markdown body. Omit to preserve the body."
    })
    .pipe(Schema.optionalKey),
  observation_period: Schema.optionalKey(
    ObservationPeriodSchema.pipe(
      Schema.annotateEncoded({
        description:
          "Evidence-backed correction of the stored observation interval. Omit to preserve it. Producer and source attribution cannot be changed."
      })
    )
  ),
  aliases: Schema.optionalKey(
    Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(4_096)))
      .check(Schema.isMaxLength(100))
      .annotate({
        description:
          "Complete replacement alias list: other names people use for this subject, never paths. [] removes all aliases. Omit to preserve aliases. A moved or merged page's old path keeps opening it on its own."
      })
  )
}).check(
  Schema.makeFilter((input) =>
    input.body !== undefined ||
    input.aliases !== undefined ||
    input.observation_period !== undefined
      ? undefined
      : "Provide body, aliases or observation_period"
  )
)

export const EditParametersSchema = Schema.Struct({
  ...PageEditSchema.fields,
  path: WikiPathSchema.pipe(Schema.optionalKey),
  edits: Schema.optionalKey(
    Schema.NonEmptyArray(PageEditSchema).check(Schema.isMaxLength(12)).annotate({
      description:
        "Edits of several pages, from 1 to 12, saved together: all or none. Give these instead of path and its fields."
    })
  )
}).check(
  Schema.makeFilter((input) => {
    const fields = [input.body, input.aliases, input.observation_period]
    if (input.edits !== undefined)
      return input.path === undefined && fields.every((field) => field === undefined)
        ? undefined
        : "Give edits, or path and its fields, not both"
    if (input.path === undefined) return "Give path, or edits"
    return fields.some((field) => field !== undefined)
      ? undefined
      : "Provide body, aliases or observation_period"
  })
)
