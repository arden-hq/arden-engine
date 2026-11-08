import { Effect, Schema } from "effect"

import { optionalAccountRefDescription, requiredAccountRefDescription } from "./google-accounts.js"

export const MAX_DOCUMENT_CHARS = 200_000

const driveAccountRefSchema = (description: string) =>
  Schema.String.annotate({ description }).check(Schema.isMinLength(1), Schema.isMaxLength(320))
const requiredAccountRefSchema = (emails: ReadonlyArray<string>) =>
  driveAccountRefSchema(
    requiredAccountRefDescription(
      "google_drive",
      "Connected Google Drive account id or email.",
      emails
    )
  )
const accountRefSchema = (emails: ReadonlyArray<string>) =>
  Schema.optionalKey(driveAccountRefSchema(optionalAccountRefDescription("google_drive", emails)))
const fileRefSchema = (description: string) =>
  Schema.String.annotate({ description }).check(Schema.isMinLength(3), Schema.isMaxLength(2_048))
export const searchParametersSchema = (emails: ReadonlyArray<string>) =>
  Schema.Struct({
    query: Schema.String.check(Schema.isMaxLength(1_024))
      .pipe(Schema.withDecodingDefault(Effect.succeed("")))
      .pipe(
        Schema.annotateEncoded({
          description:
            "Text contained in the file name or indexed content. Empty lists recent Drive files. Defaults to empty."
        })
      ),
    kind: Schema.Literals(["any", "document", "spreadsheet"] as const)
      .pipe(Schema.withDecodingDefault(Effect.succeed("any" as const)))
      .pipe(
        Schema.annotateEncoded({
          description:
            "File type to return. Any includes every file type and folders. Defaults to any."
        })
      ),
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
      .pipe(Schema.withDecodingDefault(Effect.succeed(25)))
      .pipe(
        Schema.annotateEncoded({
          description: "Maximum files per page, from 1 to 100. Defaults to 25."
        })
      ),
    account_ref: accountRefSchema(emails),
    page_ref: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Opaque next_page_ref from drive_search. Reuse it with the same query, kind, limit, and account_ref."
      }).check(Schema.isMinLength(1), Schema.isMaxLength(8_192))
    )
  })
export const ListTabsParametersSchema = Schema.Struct({
  document_ref: fileRefSchema(
    "Google Docs URL, raw document id, or exact account-qualified document_ref returned by a Drive tool."
  )
})
export const ReadDocParametersSchema = Schema.Struct({
  document_ref: fileRefSchema(
    "Google Docs URL, raw document id, or exact account-qualified document_ref returned by a Drive tool."
  ),
  tab_id: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Exact tab_id from drive_list_doc_tabs. Omit to combine all tabs in hierarchy order."
    }).check(Schema.isMinLength(1), Schema.isMaxLength(512))
  ),
  cursor: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Opaque next_cursor from drive_read_doc. It is valid only for unchanged content and the same document_ref and tab_id."
    }).check(Schema.isMinLength(1), Schema.isMaxLength(8_192))
  ),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 100_000 }))
    .pipe(Schema.withDecodingDefault(Effect.succeed(20_000)))
    .pipe(
      Schema.annotateEncoded({
        description: "Maximum characters to return, from 1,000 to 100,000. Defaults to 20,000."
      })
    )
})
export const ReadSheetParametersSchema = Schema.Struct({
  spreadsheet_ref: fileRefSchema(
    "Google Sheets URL, raw spreadsheet id, or exact account-qualified spreadsheet_ref returned by a Drive tool."
  ),
  range: Schema.String.annotate({
    description: "Bounded A1 range to read, such as Sheet1!A1:D50."
  }).check(Schema.isMinLength(1), Schema.isMaxLength(1_024))
})
export const createParametersSchema = (emails: ReadonlyArray<string>) =>
  Schema.Struct({
    account_ref: requiredAccountRefSchema(emails),
    title: Schema.String.annotate({
      description: "Title for the new file, from 1 to 1,024 characters."
    }).check(Schema.isMinLength(1), Schema.isMaxLength(1_024))
  })
export const EditDocParametersSchema = Schema.Struct({
  document_ref: fileRefSchema(
    "Google Docs URL, raw document id, or exact account-qualified document_ref returned by a Drive tool."
  ),
  operation: Schema.Literals(["append", "replace"] as const).annotate({
    description:
      "append inserts text at the document end; replace changes every exact case-sensitive match."
  }),
  text: Schema.String.annotate({
    description: "Text to append or use as the replacement, from 1 to 200,000 characters."
  }).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_DOCUMENT_CHARS)),
  match: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Exact case-sensitive text to replace everywhere. Required for replace and invalid for append."
    }).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_DOCUMENT_CHARS))
  )
})
const SheetValuesSchema = Schema.Array(
  Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]))
)
  .annotate({
    description:
      "Row-major matrix of strings, numbers, booleans, or null values, from 1 to 10,000 rows."
  })
  .check(Schema.isMinLength(1), Schema.isMaxLength(10_000))
export const SheetWriteParametersSchema = Schema.Struct({
  spreadsheet_ref: fileRefSchema(
    "Google Sheets URL, raw spreadsheet id, or exact account-qualified spreadsheet_ref returned by a Drive tool."
  ),
  range: Schema.String.annotate({
    description:
      "A1 target range for drive_update_sheet, or table range used to place rows for drive_append_sheet_rows."
  }).check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  values: SheetValuesSchema,
  value_input_option: Schema.Literals(["RAW", "USER_ENTERED"] as const)
    .pipe(Schema.withDecodingDefault(Effect.succeed("USER_ENTERED" as const)))
    .pipe(
      Schema.annotateEncoded({
        description:
          "USER_ENTERED parses values like the Sheets UI; RAW stores supplied values directly. Defaults to USER_ENTERED."
      })
    )
})
