import { Option, Schema } from "effect"

import { decodeOpaque, encodeOpaque } from "../lib/opaque-ref.js"
import { validRecipient } from "./google-gmail-mime.js"
import { toolRefusal } from "./tool-failure.js"

export const messageRef = (account: string, id: string): string => `${account}:${id}`

export const threadRef = (account: string, id: string): string =>
  `gmail-thread~${encodeOpaque({ version: 1, account, id })}`

export const parseMessageRef = (
  value: string
): { readonly account: string; readonly id: string } => {
  const separator = value.lastIndexOf(":")
  const account = value.slice(0, separator)
  const id = value.slice(separator + 1)
  if (separator < 1 || !account.includes("@") || id === "" || /\s/u.test(id)) {
    throw toolRefusal(
      "Use the exact account-qualified message_ref returned by email_search.",
      "Invalid message reference"
    )
  }
  return { account, id }
}

const ThreadRefSchema = Schema.Struct({
  version: Schema.Literal(1),
  account: Schema.String,
  id: Schema.NonEmptyString
})

export const parseThreadRef = (
  value: string
): { readonly account: string; readonly id: string } => {
  const decoded = value.startsWith("gmail-thread~")
    ? Option.getOrUndefined(decodeOpaque(ThreadRefSchema, value.slice("gmail-thread~".length)))
    : undefined
  if (decoded === undefined || !validRecipient(decoded.account) || /\s/u.test(decoded.id)) {
    throw toolRefusal(
      "Use the exact thread_ref returned by email_thread_search or email_thread_read.",
      "Invalid thread reference"
    )
  }
  return { account: decoded.account, id: decoded.id }
}

export const threadPageRef = (
  threadReference: { readonly account: string; readonly id: string },
  offset: number
): string =>
  encodeOpaque({
    version: 1,
    resource: "thread_messages",
    account: threadReference.account,
    thread: threadReference.id,
    offset
  })

const ThreadPageRefSchema = Schema.Struct({
  version: Schema.Literal(1),
  resource: Schema.Literal("thread_messages"),
  account: Schema.String,
  thread: Schema.String,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

export const decodeThreadPageRef = (
  value: string | undefined,
  threadReference: { readonly account: string; readonly id: string }
): number => {
  if (value === undefined) return 0
  const decoded = Option.getOrUndefined(decodeOpaque(ThreadPageRefSchema, value))
  if (
    decoded === undefined ||
    decoded.account !== threadReference.account ||
    decoded.thread !== threadReference.id
  ) {
    throw toolRefusal(
      "The Gmail page_ref is invalid or belongs to another thread.",
      "Invalid page reference"
    )
  }
  return decoded.offset
}

const DEFAULT_GMAIL_SEARCH_LIMIT = 8

export const GmailSearchLimitSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 50 })
).annotate({
  description: `Matches per page (1–50). Omit for an initial page of ${DEFAULT_GMAIL_SEARCH_LIMIT}; request a larger page for inventories and other broad searches. A continuation inherits its page size.`
})

const SearchPageRefSchema = Schema.Struct({
  version: Schema.Literal(1),
  resource: Schema.Literals(["messages", "threads"]),
  query: Schema.String,
  limit: GmailSearchLimitSchema,
  token: Schema.String,
  account: Schema.String
})

export const decodePageRef = (
  value: string | undefined,
  resource: "messages" | "threads",
  query: string,
  limit: number | undefined,
  accountRef: string | undefined
): { readonly token?: string; readonly accountRef?: string; readonly limit: number } => {
  if (value === undefined) {
    return {
      limit: limit ?? DEFAULT_GMAIL_SEARCH_LIMIT,
      ...(accountRef === undefined ? {} : { accountRef })
    }
  }
  const decoded = Option.getOrUndefined(decodeOpaque(SearchPageRefSchema, value))
  if (
    decoded === undefined ||
    decoded.resource !== resource ||
    decoded.query !== query ||
    (limit !== undefined && decoded.limit !== limit) ||
    (accountRef !== undefined && decoded.account !== accountRef)
  )
    throw toolRefusal(
      "The Gmail page_ref is invalid or belongs to another search.",
      "Invalid page reference"
    )
  return { token: decoded.token, accountRef: decoded.account, limit: decoded.limit }
}
