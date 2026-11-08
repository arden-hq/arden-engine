import { Schema } from "effect"
import type { EffectTarget } from "../execution/tool-effect.js"

const CALENDAR_API = "https://www.googleapis.com/calendar/v3"

export const PRIMARY_CALENDAR = "primary"

const eventsEndpoint = (calendarId: string): string =>
  `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`

export const calendarListUrl = (pageToken?: string): URL => {
  const url = new URL(`${CALENDAR_API}/users/me/calendarList`)
  url.searchParams.set("maxResults", "250")
  if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken)
  return url
}

export const calendarListEntryUrl = (calendarId: string): URL =>
  new URL(`${CALENDAR_API}/users/me/calendarList/${encodeURIComponent(calendarId)}`)

export const calendarFreeBusyUrl = (): URL => new URL(`${CALENDAR_API}/freeBusy`)

export const CalendarListEntrySchema = Schema.Struct({
  id: Schema.NonEmptyString,
  summary: Schema.optionalKey(Schema.String),
  summaryOverride: Schema.optionalKey(Schema.String),
  accessRole: Schema.optionalKey(Schema.String),
  primary: Schema.optionalKey(Schema.Boolean),
  timeZone: Schema.optionalKey(Schema.String),
  selected: Schema.optionalKey(Schema.Boolean),
  deleted: Schema.optionalKey(Schema.Boolean)
})
export type CalendarListEntry = (typeof CalendarListEntrySchema)["Type"]

export const CalendarListSchema = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(CalendarListEntrySchema)),
  nextPageToken: Schema.optionalKey(Schema.String)
})

export const canWriteCalendar = (accessRole: string | undefined): boolean =>
  accessRole === "owner" || accessRole === "writer"

export const isWatchedCalendar = (entry: CalendarListEntry): boolean =>
  entry.primary !== true &&
  entry.deleted !== true &&
  entry.selected === true &&
  (canWriteCalendar(entry.accessRole) || entry.accessRole === "reader")

export interface CalendarEventListQuery {
  readonly timeMin: string
  readonly timeMax?: string
  readonly maxResults: number
  readonly calendarId?: string
  readonly query?: string
  readonly pageToken?: string
}

export const calendarEventListUrl = (query: CalendarEventListQuery): URL => {
  const url = new URL(eventsEndpoint(query.calendarId ?? PRIMARY_CALENDAR))
  url.searchParams.set("singleEvents", "true")
  url.searchParams.set("orderBy", "startTime")
  url.searchParams.set("timeMin", query.timeMin)
  if (query.timeMax !== undefined) url.searchParams.set("timeMax", query.timeMax)
  url.searchParams.set("maxResults", String(query.maxResults))
  if (query.query !== undefined && query.query !== "") url.searchParams.set("q", query.query)
  if (query.pageToken !== undefined) url.searchParams.set("pageToken", query.pageToken)
  return url
}

export const calendarEventsUrl = (calendarId: string = PRIMARY_CALENDAR): URL =>
  new URL(eventsEndpoint(calendarId))

export const calendarEventUrl = (eventId: string, calendarId: string = PRIMARY_CALENDAR): URL =>
  new URL(`${eventsEndpoint(calendarId)}/${encodeURIComponent(eventId)}`)

export const calendarEventTarget = (eventId: string): EffectTarget => ({
  source: "calendar",
  objectId: eventId
})

const CalendarEventStartSchema = Schema.Struct({
  date: Schema.optionalKey(Schema.String),
  dateTime: Schema.optionalKey(Schema.String),
  timeZone: Schema.optionalKey(Schema.String)
})

export const CalendarAttachmentSchema = Schema.Struct({
  fileId: Schema.optionalKey(Schema.String),
  fileUrl: Schema.NonEmptyString,
  title: Schema.optionalKey(Schema.String),
  mimeType: Schema.optionalKey(Schema.String),
  iconLink: Schema.optionalKey(Schema.String)
})

const CalendarAttendeeSchema = Schema.Struct({
  email: Schema.optionalKey(Schema.String),
  responseStatus: Schema.optionalKey(Schema.String),
  self: Schema.optionalKey(Schema.Boolean)
})

const CalendarOrganizerSchema = Schema.Struct({
  email: Schema.optionalKey(Schema.String),
  self: Schema.optionalKey(Schema.Boolean)
})

const CalendarEventSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  attachments: Schema.optionalKey(Schema.Array(CalendarAttachmentSchema)),
  summary: Schema.optionalKey(Schema.String),
  location: Schema.optionalKey(Schema.String),
  start: CalendarEventStartSchema,
  end: Schema.optionalKey(CalendarEventStartSchema),
  organizer: Schema.optionalKey(CalendarOrganizerSchema),
  attendees: Schema.optionalKey(Schema.Array(CalendarAttendeeSchema)),
  status: Schema.optionalKey(Schema.String)
})
export type CalendarListedEvent = (typeof CalendarEventSchema)["Type"]

export const CalendarEventListSchema = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(CalendarEventSchema)),
  nextPageToken: Schema.optionalKey(Schema.String)
})

/**
 * One page of incremental sync. Without `syncToken` it is the first full read
 * from `timeMin`; with it, only what changed since that token, cancelled
 * events included. Google refuses `timeMin`, `orderBy` and the other filters
 * next to a sync token, so neither request sets more than the first read's
 * lower bound; a recurring series comes as one event, not expanded.
 */
export const calendarSyncUrl = (
  query: ({ readonly syncToken: string } | { readonly timeMin: string }) & {
    readonly pageToken: string | undefined
    readonly calendarId?: string
  }
): URL => {
  const url = new URL(eventsEndpoint(query.calendarId ?? PRIMARY_CALENDAR))
  if ("syncToken" in query) url.searchParams.set("syncToken", query.syncToken)
  else url.searchParams.set("timeMin", query.timeMin)
  url.searchParams.set("maxResults", "250")
  if (query.pageToken !== undefined) url.searchParams.set("pageToken", query.pageToken)
  return url
}

const CalendarSyncEventSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  attachments: Schema.optionalKey(Schema.Array(CalendarAttachmentSchema)),
  status: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  location: Schema.optionalKey(Schema.String),
  start: Schema.optionalKey(CalendarEventStartSchema),
  end: Schema.optionalKey(CalendarEventStartSchema),
  organizer: Schema.optionalKey(CalendarOrganizerSchema),
  attendees: Schema.optionalKey(Schema.Array(CalendarAttendeeSchema)),
  recurrence: Schema.optionalKey(Schema.Array(Schema.String)),
  created: Schema.optionalKey(Schema.String),
  updated: Schema.optionalKey(Schema.String)
})
export type CalendarSyncEvent = (typeof CalendarSyncEventSchema)["Type"]

export const CalendarSyncPageSchema = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(CalendarSyncEventSchema)),
  nextPageToken: Schema.optionalKey(Schema.String),
  nextSyncToken: Schema.optionalKey(Schema.String)
})
