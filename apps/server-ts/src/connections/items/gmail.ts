import { clipLine } from "@arden-hq/std/text"
import type { GoogleAccount } from "@arden-hq/protocol/google"
import { DateTime, Effect, Schema } from "effect"
import type { EffectTarget } from "../../execution/tool-effect.js"
import { GoogleConnectionError } from "../../google/errors.js"
import type { GoogleConnections } from "../../google/service.js"
import type {
  ConnectionItemStore,
  FetchedConnectionItem
} from "../../persistence/connections/store.js"
import { keepMail, redactText } from "./filter.js"
import { FetchError } from "./fetch-error.js"

const API = "https://gmail.googleapis.com/gmail/v1/users/me"
const FIRST_FETCH_DAYS = 3
const MAX_MESSAGES = 200
const MAX_HISTORY_PAGES = 10
/** Messages read at once: a message read costs 5 of Gmail's 250 quota units a second. */
const READ_CONCURRENCY = 5

const ProfileSchema = Schema.Struct({ historyId: Schema.String })
const MessageListSchema = Schema.Struct({
  messages: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String })))
})
const HistorySchema = Schema.Struct({
  historyId: Schema.String,
  nextPageToken: Schema.optionalKey(Schema.String),
  history: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        messagesAdded: Schema.optionalKey(
          Schema.Array(Schema.Struct({ message: Schema.Struct({ id: Schema.String }) }))
        )
      })
    )
  )
})
const MessageSchema = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  labelIds: Schema.optionalKey(Schema.Array(Schema.String)),
  snippet: Schema.optionalKey(Schema.String),
  internalDate: Schema.optionalKey(Schema.String),
  payload: Schema.optionalKey(
    Schema.Struct({
      headers: Schema.optionalKey(
        Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String }))
      )
    })
  )
})

export const gmailThreadTarget = (threadId: string): EffectTarget => ({
  source: "gmail",
  objectId: threadId
})

export const hasReadyGmail = (account: GoogleAccount): boolean =>
  account.authorizations.some(
    (authorization) => authorization.service === "gmail" && authorization.status === "ready"
  )

export const fetchGmail = Effect.fn("ConnectionItems.fetchGmail")(function* (input: {
  readonly google: Pick<GoogleConnections["Service"], "request">
  readonly store: Pick<ConnectionItemStore["Service"], "threadOwned">
  readonly account: GoogleAccount
  readonly cursor: string | undefined
}): Effect.fn.Return<
  { readonly cursor: string; readonly items: ReadonlyArray<FetchedConnectionItem> },
  FetchError
> {
  const get = <S extends Schema.Top>(schema: S, url: string) =>
    input.google
      .request({ service: "gmail", url, accountRef: input.account.id })
      .pipe(Effect.flatMap(({ value }) => Schema.decodeUnknownEffect(schema)(value)))
  const fresh = Effect.gen(function* () {
    const profile = yield* get(ProfileSchema, `${API}/profile`)
    const query = new URLSearchParams({
      q: `in:inbox newer_than:${FIRST_FETCH_DAYS}d -from:me`,
      maxResults: String(MAX_MESSAGES)
    })
    const list = yield* get(MessageListSchema, `${API}/messages?${query}`)
    return { cursor: profile.historyId, ids: (list.messages ?? []).map((message) => message.id) }
  })
  const since = Effect.fnUntraced(function* (startHistoryId: string) {
    const records: Array<{ readonly id: string; readonly ids: ReadonlyArray<string> }> = []
    let pageToken: string | undefined
    let newest = startHistoryId
    let seen = 0
    for (let page = 0; page < MAX_HISTORY_PAGES && seen <= MAX_MESSAGES; page += 1) {
      const query = new URLSearchParams({
        startHistoryId,
        historyTypes: "messageAdded",
        labelId: "INBOX",
        maxResults: "100",
        ...(pageToken === undefined ? {} : { pageToken })
      })
      const history = yield* get(HistorySchema, `${API}/history?${query}`)
      newest = history.historyId
      for (const entry of history.history ?? []) {
        const ids = (entry.messagesAdded ?? []).map((added) => added.message.id)
        records.push({ id: entry.id, ids })
        seen += ids.length
      }
      pageToken = history.nextPageToken
      if (pageToken === undefined) break
    }
    return readUpTo(records, { startHistoryId, newest, complete: pageToken === undefined })
  })
  // Gmail answers 404 for a history id it no longer keeps (about a week).
  const expired = (error: unknown) => httpStatus(error, [404])
  const found = yield* (
    input.cursor === undefined
      ? fresh
      : since(input.cursor).pipe(Effect.catchIf(expired, () => fresh))
  ).pipe(Effect.mapError(fetchFailed))
  const query = new URLSearchParams([
    ["format", "metadata"],
    ...["From", "Subject"].map((header): [string, string] => ["metadataHeaders", header])
  ])
  const read = yield* Effect.forEach(
    found.ids,
    (id) =>
      get(MessageSchema, `${API}/messages/${encodeURIComponent(id)}?${query}`).pipe(
        Effect.map((message) => ({ _tag: "read" as const, message })),
        Effect.catchIf(
          (error) => httpStatus(error, [404, 410]),
          () =>
            Effect.logInfo("A Gmail message is gone; skipped", {
              account: input.account.id,
              id
            }).pipe(Effect.as({ _tag: "gone" as const }))
        ),
        Effect.mapError(fetchFailed),
        Effect.flatMap((read) =>
          read._tag === "gone" ? Effect.succeed(undefined) : toItem(input, read.message)
        )
      ),
    { concurrency: READ_CONCURRENCY }
  )
  return { cursor: found.cursor, items: read.filter((item) => item !== undefined) }
})

const readUpTo = (
  records: ReadonlyArray<{ readonly id: string; readonly ids: ReadonlyArray<string> }>,
  position: { readonly startHistoryId: string; readonly newest: string; readonly complete: boolean }
): { readonly cursor: string; readonly ids: ReadonlyArray<string> } => {
  const ids = new Set<string>()
  let last: string | undefined
  for (const record of records) {
    const fresh = record.ids.filter((id) => !ids.has(id))
    if (ids.size > 0 && ids.size + fresh.length > MAX_MESSAGES)
      return { cursor: last ?? position.startHistoryId, ids: [...ids] }
    for (const id of fresh) ids.add(id)
    last = record.id
  }
  return {
    cursor: position.complete ? position.newest : (last ?? position.startHistoryId),
    ids: [...ids]
  }
}

const httpStatus = (error: unknown, statuses: ReadonlyArray<number>): boolean =>
  error instanceof GoogleConnectionError &&
  error.diagnostic.kind === "http" &&
  statuses.includes(error.diagnostic.status)

const fetchFailed = (cause: unknown): FetchError =>
  new FetchError({ source: "gmail", message: "Gmail fetch failed", cause })

const toItem = Effect.fn("ConnectionItems.gmailItem")(function* (
  input: {
    readonly store: Pick<ConnectionItemStore["Service"], "threadOwned">
    readonly account: GoogleAccount
  },
  message: typeof MessageSchema.Type
): Effect.fn.Return<FetchedConnectionItem | undefined, FetchError> {
  const headers = new Map(
    (message.payload?.headers ?? []).map((header) => [header.name.toLowerCase(), header.value])
  )
  const from = headers.get("from") ?? ""
  const subject = headers.get("subject") ?? ""
  const kept =
    keepMail({ labelIds: message.labelIds ?? [], subject }) ||
    (yield* input.store
      .threadOwned({ source: "gmail", account: input.account.id, threadKey: message.threadId })
      .pipe(
        Effect.mapError(
          (cause) =>
            new FetchError({ source: "gmail", message: "Could not read the thread", cause })
        )
      ))
  if (!kept) return undefined
  const received = Number(message.internalDate)
  return {
    source: "gmail",
    account: input.account.id,
    externalId: message.id,
    threadKey: message.threadId,
    title: redactText(subject, 300) || "(no subject)",
    sender: from.length === 0 ? undefined : clipLine(from, 200),
    receivedAt: Number.isFinite(received)
      ? DateTime.formatIso(DateTime.makeUnsafe(received))
      : DateTime.formatIso(yield* DateTime.now),
    snippet: redactText(message.snippet ?? "", 280)
  }
})
