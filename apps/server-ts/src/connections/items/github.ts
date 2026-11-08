import { clipLine } from "@arden-hq/std/text"
import { DateTime, Effect, Schema } from "effect"
import {
  CONNECTION_ITEM_KEEP_DAYS,
  type FetchedConnectionItem
} from "../../persistence/connections/store.js"
import { redactText } from "./filter.js"
import { FetchError } from "./fetch-error.js"

export const GITHUB_ACCOUNT = "github"
const FIRST_FETCH_DAYS = 3
const DEFAULT_POLL_SECONDS = 60
const TIMEOUT_MS = 15_000

const NotificationSchema = Schema.Struct({
  id: Schema.String,
  reason: Schema.String,
  updated_at: Schema.String,
  subject: Schema.Struct({
    title: Schema.String,
    url: Schema.NullOr(Schema.String),
    type: Schema.String
  }),
  repository: Schema.Struct({ full_name: Schema.String })
})
type Notification = typeof NotificationSchema.Type

const SUBJECT_URL = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(?:issues|pulls)\/(\d+)$/

const githubThreadKey = (notification: {
  readonly id: string
  readonly subject: { readonly url: string | null }
}): string => {
  const match = SUBJECT_URL.exec(notification.subject.url ?? "")
  return match === null ? `thread:${notification.id}` : `${match[1]}#${match[2]}`
}

const words = (value: string): string =>
  value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ")

const MAX_PAGES = 5

const later = (left: string, right: string): boolean => Date.parse(left) > Date.parse(right)

const nextPage = (link: string | null): string | undefined =>
  /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1]

export const fetchGitHub = Effect.fn("ConnectionItems.fetchGitHub")(function* (input: {
  readonly token: string
  readonly cursor: string | undefined
  readonly since: string | undefined
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
}): Effect.fn.Return<
  {
    readonly cursor: string | undefined
    readonly since: string | undefined
    readonly pollAfter: string
    readonly items: ReadonlyArray<FetchedConnectionItem>
  },
  FetchError
> {
  const now = yield* DateTime.now
  const oldest = DateTime.formatIso(DateTime.subtract(now, { days: CONNECTION_ITEM_KEEP_DAYS }))
  const fallback = DateTime.formatIso(DateTime.subtract(now, { days: FIRST_FETCH_DAYS }))
  const asked = input.since ?? fallback
  const since = later(asked, oldest) ? asked : oldest
  const query = new URLSearchParams({ participating: "true", per_page: "50", since })
  const fetcher = input.fetch ?? ((url: string, init: RequestInit) => globalThis.fetch(url, init))
  const request = (url: string, first: boolean) =>
    Effect.tryPromise({
      try: () =>
        fetcher(url, {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${input.token}`,
            "User-Agent": "Arden",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(first && input.cursor !== undefined ? { "If-Modified-Since": input.cursor } : {})
          },
          signal: AbortSignal.timeout(TIMEOUT_MS)
        }),
      catch: (cause) =>
        new FetchError({ source: "github", message: "GitHub could not be reached", cause })
    })
  const page = Effect.fnUntraced(function* (response: Response) {
    if (!response.ok)
      return yield* new FetchError({
        source: "github",
        message: `GitHub answered ${response.status} for notifications`
      })
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) =>
        new FetchError({ source: "github", message: "GitHub sent invalid data", cause })
    })
    return yield* Schema.decodeUnknownEffect(Schema.Array(NotificationSchema))(body).pipe(
      Effect.mapError(
        (cause) => new FetchError({ source: "github", message: "GitHub sent invalid data", cause })
      )
    )
  })
  const response = yield* request(`https://api.github.com/notifications?${query}`, true)
  const interval = Number(response.headers.get("x-poll-interval") ?? DEFAULT_POLL_SECONDS)
  const pollAfter = DateTime.formatIso(
    DateTime.add(now, {
      seconds: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_POLL_SECONDS
    })
  )
  if (response.status === 304)
    return { cursor: input.cursor, since: input.since, pollAfter, items: [] }
  const notifications = [...(yield* page(response))]
  let next = nextPage(response.headers.get("link"))
  for (let pages = 1; next !== undefined && pages < MAX_PAGES; pages += 1) {
    const more = yield* request(next, false)
    notifications.push(...(yield* page(more)))
    next = nextPage(more.headers.get("link"))
  }
  const fresh = notifications.filter((notification) => !later(since, notification.updated_at))
  const items = fresh.filter((notification) => notification.reason !== "ci_activity").map(toItem)
  return {
    cursor: response.headers.get("last-modified") ?? input.cursor,
    since: fresh.reduce(
      (newest, notification) =>
        later(notification.updated_at, newest) ? notification.updated_at : newest,
      since
    ),
    pollAfter,
    items
  }
})

const toItem = (notification: Notification): FetchedConnectionItem => {
  const threadKey = githubThreadKey(notification)
  const repository = notification.repository.full_name
  return {
    source: "github",
    account: GITHUB_ACCOUNT,
    externalId: `${notification.id}@${notification.updated_at}`,
    threadKey,
    title: clipLine(`${repository}: ${redactText(notification.subject.title, 300)}`, 300),
    sender: clipLine(repository, 200),
    receivedAt: notification.updated_at,
    snippet: clipLine(`${words(notification.subject.type)}, ${words(notification.reason)}.`, 280)
  }
}
