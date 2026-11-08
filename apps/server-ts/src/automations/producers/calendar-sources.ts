import { googleAccountHasGrant, type GoogleAccount } from "@arden-hq/protocol/google"
import { Effect, Schema } from "effect"

import {
  calendarListUrl,
  CalendarListSchema,
  isWatchedCalendar,
  PRIMARY_CALENDAR,
  type CalendarListEntry
} from "../../google/calendar-client.js"
import { GoogleConnections } from "../../google/service.js"

const MAX_LIST_PAGES = 4

const watchedCalendarIds = (entries: ReadonlyArray<CalendarListEntry>): ReadonlyArray<string> => [
  PRIMARY_CALENDAR,
  ...entries.filter(isWatchedCalendar).map((entry) => entry.id)
]

export const calendarKeyPart = (calendarId: string): string =>
  calendarId === PRIMARY_CALENDAR ? "" : `:${calendarId}`

export const watchedCalendars = Effect.fn("AutomationTriggerProducers.watchedCalendars")(function* (
  account: GoogleAccount
) {
  if (!googleAccountHasGrant(account, "calendar_list")) return [PRIMARY_CALENDAR]
  const google = yield* GoogleConnections
  const entries: Array<CalendarListEntry> = []
  let pageToken: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = yield* google
      .request({
        service: "calendar",
        url: calendarListUrl(pageToken).href,
        accountRef: account.id
      })
      .pipe(
        Effect.flatMap((response) =>
          Schema.decodeUnknownEffect(CalendarListSchema)(response.value)
        ),
        Effect.option
      )
    if (result._tag === "None") return [PRIMARY_CALENDAR]
    entries.push(...(result.value.items ?? []))
    pageToken = result.value.nextPageToken
    if (pageToken === undefined || pageToken === "") break
  }
  return watchedCalendarIds(entries)
})
