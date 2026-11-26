import { cutBytes, foldSpace } from "@arden-hq/std/text"
import { Effect, Schema } from "effect"

import { optionalAccountRefDescription } from "./google-accounts.js"
import { attachmentMetadata } from "./google-gmail-mime.js"
import { GmailSearchLimitSchema } from "./google-gmail-refs.js"
import { decodeGoogle } from "./google-request.js"

export const MAX_THREAD_PAGE_CONTENT_BYTES = 36 * 1_024
const METADATA_CONCURRENCY = 4
const MAX_SEARCH_SNIPPET_BYTES = 160

export const searchSnippet = (snippet: string): string =>
  cutBytes(foldSpace(snippet), MAX_SEARCH_SNIPPET_BYTES)

export const renderAttachments = (files: ReturnType<typeof attachmentMetadata>): string =>
  [
    "Attachments:",
    ...files.map(
      (file) =>
        `${file.index}. ${file.filename} · ${file.mime_type} · ${file.byte_length === null ? "size unknown" : `${file.byte_length} bytes`}`
    )
  ].join("\n")

const accountRefSchema = (emails: ReadonlyArray<string>) =>
  Schema.optionalKey(
    Schema.String.annotate({
      description: optionalAccountRefDescription("gmail", emails)
    }).check(Schema.isMinLength(1), Schema.isMaxLength(320))
  )
export type SearchParametersSchema = Schema.Struct<{
  readonly query: Schema.withDecodingDefault<Schema.String, never>
  readonly limit: Schema.optionalKey<Schema.Int>
  readonly account_ref: Schema.optionalKey<Schema.String>
  readonly page_ref: Schema.optionalKey<Schema.String>
}>

export const searchParametersSchema = (emails: ReadonlyArray<string>): SearchParametersSchema =>
  Schema.Struct({
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048))
      .pipe(Schema.withDecodingDefault(Effect.succeed("newer_than:7d")))
      .pipe(
        Schema.annotateEncoded({
          description:
            "Gmail search query, including Gmail operators such as from:, is:, and newer_than:. Narrow the query for targeted lookup. Defaults to newer_than:7d."
        })
      ),
    limit: Schema.optionalKey(GmailSearchLimitSchema),
    account_ref: accountRefSchema(emails),
    page_ref: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Use the opaque next_page_ref from the same search tool when more matches are needed. Reuse the query and omit limit and account_ref to inherit them from the cursor."
      }).check(Schema.isMinLength(1), Schema.isMaxLength(8_192))
    )
  })
export const ReadParametersSchema = Schema.Struct({
  message_ref: Schema.String.annotate({
    description:
      "Exact account-qualified message_ref returned by email_search or email_thread_read."
  }).check(Schema.isMinLength(3), Schema.isMaxLength(1_024))
})
export const ThreadReadParametersSchema = Schema.Struct({
  thread_ref: Schema.String.annotate({
    description:
      "Exact thread_ref returned by email_search, email_thread_search, or email_thread_read."
  }).check(Schema.isMinLength(3), Schema.isMaxLength(2_048)),
  page_ref: Schema.optionalKey(
    Schema.String.annotate({
      description: "Opaque next_page_ref returned by email_thread_read for this same thread."
    }).check(Schema.isMinLength(1), Schema.isMaxLength(8_192))
  )
})

const GmailIdsSchema = Schema.optionalKey(
  Schema.Array(Schema.Struct({ id: Schema.NonEmptyString }))
)
export const messageList = decodeGoogle(
  Schema.Struct({ messages: GmailIdsSchema, nextPageToken: Schema.optionalKey(Schema.String) }),
  { service: "gmail", label: "message list" }
)
export const threadList = decodeGoogle(
  Schema.Struct({ threads: GmailIdsSchema, nextPageToken: Schema.optionalKey(Schema.String) }),
  { service: "gmail", label: "thread list" }
)

export const settledInBatches = async <A, B>(
  values: ReadonlyArray<A>,
  operation: (value: A) => Promise<B>,
  signal: AbortSignal
): Promise<ReadonlyArray<PromiseSettledResult<B>>> => {
  const settled: Array<PromiseSettledResult<B>> = []
  for (let offset = 0; offset < values.length; offset += METADATA_CONCURRENCY) {
    signal.throwIfAborted()
    settled.push(
      ...(await Promise.allSettled(
        values.slice(offset, offset + METADATA_CONCURRENCY).map(operation)
      ))
    )
    signal.throwIfAborted()
  }
  return settled
}
