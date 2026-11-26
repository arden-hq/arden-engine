import { Effect, Schema } from "effect"

import { PathSchema } from "./file-tool-support.js"
import { textSelectFields } from "./text-select.js"
import { FIND_ALL_PATTERN } from "./ripgrep.js"

export const SEARCH_OUTPUT_MODE = {
  content: "content",
  filesOnly: "files_only",
  count: "count"
} as const

export type SearchOutputMode = (typeof SEARCH_OUTPUT_MODE)[keyof typeof SEARCH_OUTPUT_MODE]

export const MAX_DISCOVERY_ENTRIES = 100_000
export const MAX_READ_BYTES = 64 * 1024 * 1024

const ReadOffsetSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 10_000_000 })
).pipe(
  Schema.withDecodingDefault(Effect.succeed(1)),
  Schema.annotateEncoded({
    description: "First 1-based line to return (1-10,000,000). Defaults to 1."
  })
)

const ReadLimitSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })).pipe(
  Schema.withDecodingDefault(Effect.succeed(500)),
  Schema.annotateEncoded({
    description: "Maximum lines to return (1-10,000). Defaults to 500."
  })
)

const EntryLimitSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })).pipe(
  Schema.withDecodingDefault(Effect.succeed(200)),
  Schema.annotateEncoded({
    description: "Maximum entries to return (1-1,000). Defaults to 200."
  })
)

const MatchLimitSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })).pipe(
  Schema.withDecodingDefault(Effect.succeed(100)),
  Schema.annotateEncoded({
    description: "Maximum match records to return (1-1,000). Defaults to 100."
  })
)

const CursorSchema = Schema.optionalKey(
  Schema.String.check(Schema.isMaxLength(1_000)).annotate({
    description:
      "Opaque next_cursor from the preceding page; reuse only with the identical request."
  })
)

export const ReadParametersSchema = Schema.Struct({
  path: PathSchema.annotate({
    description:
      "Local file path or an arden:managed-output reference from this chat. Relative file paths use the current Local folder."
  }),
  offset: ReadOffsetSchema,
  limit: ReadLimitSchema,
  line_numbers: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    Schema.annotateEncoded({
      description:
        "Prefix each source line with its 1-based number (number|text). Defaults to true. Set false for plain text."
    })
  ),
  ...textSelectFields
})

export const ListParametersSchema = Schema.Struct({
  path: PathSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(".")),
    Schema.annotateEncoded({
      description:
        "Directory to list. Relative paths use the current Local folder; defaults to '.'."
    })
  ),
  limit: EntryLimitSchema,
  include_hidden: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
    Schema.annotateEncoded({
      description: "Include entries whose names start with '.'. Defaults to false."
    })
  ),
  cursor: CursorSchema
})

export const FindParametersSchema = Schema.Struct({
  path: PathSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(".")),
    Schema.annotateEncoded({
      description:
        "Directory root for recursive discovery. Relative paths use the current Local folder; defaults to '.'."
    })
  ),
  pattern: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)).pipe(
    Schema.withDecodingDefault(Effect.succeed(FIND_ALL_PATTERN)),
    Schema.annotateEncoded({
      description: "File-path glob such as '**/*.ts' (1-1,024 characters). Defaults to '*'."
    })
  ),
  limit: EntryLimitSchema,
  include_hidden: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
    Schema.annotateEncoded({
      description:
        "Include hidden files while still respecting ignore files and fixed exclusions. Defaults to false."
    })
  )
})

export const SearchParametersSchema = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
    description:
      "Literal, case-sensitive text to search for; not a regular expression (1-4,096 characters)."
  }),
  path: PathSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(".")),
    Schema.annotateEncoded({
      description:
        "File or directory to search. Relative paths use the current Local folder; defaults to '.'."
    })
  ),
  file_glob: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)).annotate({
      description: "Optional file-path glob such as '**/*.ts'; it filters files, not matched text."
    })
  ),
  output_mode: Schema.Literals(Object.values(SEARCH_OUTPUT_MODE)).pipe(
    Schema.withDecodingDefault(Effect.succeed(SEARCH_OUTPUT_MODE.content)),
    Schema.annotateEncoded({
      description:
        "Return matching lines, matching file paths, or per-file counts. Defaults to content."
    })
  ),
  include_hidden: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    Schema.annotateEncoded({
      description:
        "Search hidden files while still excluding ignored files and VCS/dependency/cache directories. Defaults to true."
    })
  ),
  limit: MatchLimitSchema,
  cursor: CursorSchema
})
