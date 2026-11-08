import { Effect, Schema } from "effect"

import { optionalAccountRefDescription, requiredAccountRefDescription } from "./google-accounts.js"
import {
  CalendarAttachmentRefsSchema,
  CalendarRemoveAttachmentsSchema
} from "./google-calendar-attachments.js"

const calendarAccountRefSchema = (description: string) =>
  Schema.String.annotate({ description }).check(Schema.isMinLength(1), Schema.isMaxLength(320))
const requiredAccountRefSchema = (emails: ReadonlyArray<string>) =>
  calendarAccountRefSchema(
    requiredAccountRefDescription(
      "calendar",
      "Connected Google Calendar account id or email.",
      emails
    )
  )
const accountRefSchema = (emails: ReadonlyArray<string>) =>
  Schema.optionalKey(calendarAccountRefSchema(optionalAccountRefDescription("calendar", emails)))
const calendarIdSchema = (verb: string) =>
  Schema.optionalKey(
    Schema.String.annotate({
      description: `Calendar to ${verb}: an id from calendar_list_calendars. Defaults to the calendar in event_ref when supplied, otherwise "primary".`
    }).check(Schema.isMinLength(1), Schema.isMaxLength(320))
  )
export const CalendarDateTimeSchema = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u
  )
)
const dateTimeSchema = (description: string) =>
  Schema.String.annotate({ description }).check(Schema.isMinLength(1), Schema.isMaxLength(128))
const LimitSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
  .pipe(Schema.withDecodingDefault(Effect.succeed(25)))
  .pipe(
    Schema.annotateEncoded({
      description: "Maximum events per page, from 1 to 100. Defaults to 25."
    })
  )
export const searchParametersSchema = (emails: ReadonlyArray<string>) =>
  Schema.Struct({
    query: Schema.String.check(Schema.isMaxLength(1_024))
      .pipe(Schema.withDecodingDefault(Effect.succeed("")))
      .pipe(
        Schema.annotateEncoded({
          description: "Free-text event query. Empty lists events. Defaults to empty."
        })
      ),
    time_min: Schema.optionalKey(
      dateTimeSchema(
        "Lower ISO 8601 date-time bound with an explicit offset or Z. Defaults to 24 hours before execution."
      )
    ),
    time_max: Schema.optionalKey(
      dateTimeSchema(
        "Upper ISO 8601 date-time bound with an explicit offset or Z. Must be after time_min."
      )
    ),
    limit: LimitSchema,
    account_ref: accountRefSchema(emails),
    calendar_id: calendarIdSchema("search"),
    page_ref: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Opaque next_page_ref from calendar_search. Reuse it with the same query, time bounds, limit, and account_ref."
      }).check(Schema.isMinLength(1), Schema.isMaxLength(8_192))
    )
  })
const allDaySchema = Schema.optionalKey(
  Schema.Boolean.annotate({
    description:
      "true for an all-day event: start and end are then dates, YYYY-MM-DD, both inclusive (a Monday-to-Wednesday event is start 2026-10-12, end 2026-10-14; end defaults to start)."
  })
)
const addMeetSchema = Schema.optionalKey(
  Schema.Boolean.annotate({
    description: "true to add a Google Meet link to the event."
  })
)
const remindersSchema = Schema.optionalKey(
  Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 40_320 })))
    .annotate({
      description:
        "Popup reminders as minutes before the start, up to 5. Replaces the calendar defaults; an empty list means no reminders. Omit it to keep the calendar defaults."
    })
    .check(Schema.isMaxLength(5))
)
const scopeSchema = Schema.optionalKey(
  Schema.Literals(["this", "series"]).annotate({
    description:
      'For a recurring event: "this" (default) changes only the instance event_ref names; "series" changes every occurrence. Ignored for a single event.'
  })
)
const AttendeeSchema = Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320))
export const createParametersSchema = (emails: ReadonlyArray<string>) =>
  Schema.Struct({
    attachments: Schema.optionalKey(CalendarAttachmentRefsSchema),
    account_ref: requiredAccountRefSchema(emails),
    calendar_id: calendarIdSchema("create the event in"),
    title: Schema.String.annotate({
      description: "Event title, from 1 to 1,024 characters."
    }).check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
    start: dateTimeSchema(
      "Event start as an ISO 8601 date-time with an explicit offset or Z; a date, YYYY-MM-DD, when all_day."
    ),
    end: Schema.optionalKey(
      dateTimeSchema(
        "Event end as an ISO 8601 date-time with an explicit offset or Z. Must be after start. Required unless all_day, where it is the last day, inclusive."
      )
    ),
    all_day: allDaySchema,
    timezone: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "IANA display time zone attached to both start and end, such as America/New_York; start and end still need explicit offsets."
      }).check(Schema.isMinLength(1), Schema.isMaxLength(128))
    ),
    recurrence: Schema.optionalKey(
      Schema.Array(Schema.String.check(Schema.isMinLength(6), Schema.isMaxLength(512)))
        .annotate({
          description:
            'Recurrence lines that make the event repeat, each starting RRULE:, EXDATE: or RDATE:, such as ["RRULE:FREQ=WEEKLY;BYDAY=MO"]. A timed recurring event also needs timezone.'
        })
        .check(Schema.isMaxLength(10))
    ),
    add_meet: addMeetSchema,
    reminders: remindersSchema,
    description: Schema.optionalKey(
      Schema.String.annotate({
        description: "Optional event description, up to 32,768 characters."
      }).check(Schema.isMaxLength(32_768))
    ),
    location: Schema.optionalKey(
      Schema.String.annotate({
        description: "Optional event location, up to 2,048 characters."
      }).check(Schema.isMaxLength(2_048))
    ),
    attendees: Schema.Array(AttendeeSchema)
      .check(Schema.isMaxLength(100))
      .pipe(Schema.withDecodingDefault(Effect.succeed([])))
      .pipe(
        Schema.annotateEncoded({
          description:
            "Attendee email addresses, up to 100. Defaults to none; non-empty sends invitations."
        })
      )
  })
export const EditParametersSchema = Schema.Struct({
  add_attachments: Schema.optionalKey(CalendarAttachmentRefsSchema),
  remove_attachments: Schema.optionalKey(CalendarRemoveAttachmentsSchema),
  calendar_id: calendarIdSchema("edit"),
  event_ref: Schema.String.annotate({
    description: "Exact account-qualified event_ref returned by calendar_search."
  }).check(Schema.isMinLength(3), Schema.isMaxLength(1_024)),
  title: Schema.optionalKey(
    Schema.String.annotate({
      description: "Replacement event title, from 1 to 1,024 characters."
    }).check(Schema.isMinLength(1), Schema.isMaxLength(1_024))
  ),
  start: Schema.optionalKey(
    dateTimeSchema(
      "Replacement ISO 8601 start with an explicit offset or Z; a date, YYYY-MM-DD, when all_day. Provide start and end together (all_day: end is optional)."
    )
  ),
  end: Schema.optionalKey(
    dateTimeSchema(
      "Replacement ISO 8601 end with an explicit offset or Z. Provide start and end together; end must be later. With all_day it is the last day, inclusive."
    )
  ),
  all_day: allDaySchema,
  scope: scopeSchema,
  add_meet: addMeetSchema,
  reminders: remindersSchema,
  timezone: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Replacement IANA display time zone. Provide it with start and end; it does not replace explicit offsets."
    }).check(Schema.isMinLength(1), Schema.isMaxLength(128))
  ),
  description: Schema.optionalKey(
    Schema.String.annotate({
      description: "Replacement description. Empty clears it."
    }).check(Schema.isMaxLength(32_768))
  ),
  location: Schema.optionalKey(
    Schema.String.annotate({
      description: "Replacement location. Empty clears it."
    }).check(Schema.isMaxLength(2_048))
  ),
  attendees: Schema.optionalKey(
    Schema.Array(AttendeeSchema)
      .annotate({
        description:
          "Complete replacement attendee email list, up to 100. Providing it emails every attendee even when the list is unchanged; empty removes all; omit it to leave attendees alone."
      })
      .check(Schema.isMaxLength(100))
  )
})
export const DeleteParametersSchema = Schema.Struct({
  calendar_id: calendarIdSchema("delete from"),
  event_ref: Schema.String.annotate({
    description: "Exact account-qualified event_ref returned by calendar_search."
  }).check(Schema.isMinLength(3), Schema.isMaxLength(1_024)),
  scope: scopeSchema
})

export const readParametersSchema = (emails: ReadonlyArray<string>) =>
  Schema.Struct({
    event_id: Schema.String.annotate({
      description:
        "Google Calendar event id, from a calendar Automation event or the part after the last colon of an event_ref."
    }).check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
    account: requiredAccountRefSchema(emails),
    calendar_id: calendarIdSchema("read from")
  })

export const listCalendarsParametersSchema = (emails: ReadonlyArray<string>) =>
  Schema.Struct({ account_ref: accountRefSchema(emails) })

const EventRefSchema = Schema.String.annotate({
  description: "Exact account-qualified event_ref returned by calendar_search."
}).check(Schema.isMinLength(3), Schema.isMaxLength(1_024))

export const RespondParametersSchema = Schema.Struct({
  calendar_id: calendarIdSchema("answer on"),
  event_ref: EventRefSchema,
  response: Schema.Literals(["accepted", "declined", "tentative"]).annotate({
    description: "Your answer to the invitation."
  }),
  comment: Schema.optionalKey(
    Schema.String.annotate({
      description: "Optional note to the organizer, up to 1,024 characters."
    }).check(Schema.isMaxLength(1_024))
  ),
  scope: scopeSchema
})

export const freeBusyParametersSchema = (emails: ReadonlyArray<string>) =>
  Schema.Struct({
    account_ref: accountRefSchema(emails),
    calendars: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(320)))
      .annotate({
        description:
          'Whose availability to read, up to 20: "primary" for the account\'s own calendar, calendar ids from calendar_list_calendars, or other people\'s email addresses. Defaults to ["primary"]. A calendar Google will not share is reported as unknown, never as free.'
      })
      .check(Schema.isMinLength(1), Schema.isMaxLength(20))
      .pipe(Schema.withDecodingDefault(Effect.succeed(["primary"]))),
    time_min: dateTimeSchema("Start of the window, ISO 8601 with an explicit offset or Z."),
    time_max: dateTimeSchema(
      "End of the window, ISO 8601 with an explicit offset or Z. At most 62 days after time_min."
    ),
    find_slots: Schema.optionalKey(
      Schema.Struct({
        duration_minutes: Schema.Int.annotate({
          description: "Shortest free stretch to report, 5 to 1,440 minutes."
        }).check(Schema.isBetween({ minimum: 5, maximum: 1_440 })),
        timezone: Schema.String.annotate({
          description:
            "IANA time zone of the working hours, such as America/New_York: the user's zone."
        }).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
        working_start: Schema.optionalKey(
          Schema.String.annotate({
            description: 'Working day start, "HH:MM". Defaults to "09:00".'
          })
        ),
        working_end: Schema.optionalKey(
          Schema.String.annotate({ description: 'Working day end, "HH:MM". Defaults to "17:00".' })
        ),
        include_weekends: Schema.optionalKey(
          Schema.Boolean.annotate({
            description: "true to offer Saturdays and Sundays. Defaults to false."
          })
        )
      }).annotate({
        description:
          "Also list the stretches inside working hours when every known calendar is free for at least duration_minutes."
      })
    )
  })
