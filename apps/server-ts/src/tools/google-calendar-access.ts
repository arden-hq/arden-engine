import {
  calendarListEntryUrl,
  canWriteCalendar,
  CalendarListEntrySchema,
  PRIMARY_CALENDAR
} from "../google/calendar-client.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import type { GoogleGrantDescription, GoogleToolGrant } from "./google-tool-grant.js"
import { decodeGoogle, googleCall } from "./google-request.js"
import { toolRefusal } from "./tool-failure.js"

export const LIST_CALENDARS_GRANT = {
  grant: "calendar_list",
  what: "see your list of calendars",
  note: "Approving asks Google to let Arden see which calendars you have and your role on each."
} as const satisfies GoogleGrantDescription

export const FREE_BUSY_GRANT = {
  grant: "calendar_freebusy",
  what: "check when calendars are busy",
  note: "Approving asks Google to let Arden see when calendars are busy, not what the events are."
} as const satisfies GoogleGrantDescription

export const calendarWriteGrant = <Input>({
  google,
  target
}: {
  readonly google: GoogleToolConnections
  readonly target: (input: Input) => {
    readonly accountRef: string | undefined
    readonly calendarId: string
  }
}): GoogleToolGrant<Input> => ({
  ...LIST_CALENDARS_GRANT,
  note: "Approving asks Google to let Arden see your role on this calendar, so it can tell whether you may change it.",
  target: (input) => {
    const resolved = target(input)
    return resolved.calendarId === PRIMARY_CALENDAR
      ? undefined
      : { accountRef: resolved.accountRef }
  },
  validate: (input, ctx) => calendarWriteAccess({ google, ...target(input), signal: ctx.signal })
})

const decodeCalendarEntry = decodeGoogle(CalendarListEntrySchema, {
  service: "calendar",
  label: "calendar"
})

export const calendarWriteAccess = async (input: {
  readonly google: GoogleToolConnections
  readonly accountRef: string | undefined
  readonly calendarId: string
  readonly signal: AbortSignal
}): Promise<void> => {
  if (input.calendarId === PRIMARY_CALENDAR) return
  const response = await googleCall({
    google: input.google,
    service: "calendar",
    url: calendarListEntryUrl(input.calendarId).href,
    accountRef: input.accountRef,
    signal: input.signal
  })
  const role = decodeCalendarEntry(response.value).accessRole
  if (!canWriteCalendar(role)) {
    throw toolRefusal(
      `This calendar is read-only for ${response.account.email} (access role: ${role ?? "unknown"}). Events on it cannot be created, changed, deleted or answered.`,
      "Calendar is read-only"
    )
  }
}
