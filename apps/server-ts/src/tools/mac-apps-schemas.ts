import { Schema } from "effect"

const WHEN =
  "a day (2026-11-18), a time in this Mac's time zone (2026-11-18T09:30) or a time with an offset (2026-11-18T09:30:00+01:00)"

const required = (description: string, max: number) =>
  Schema.String.annotate({ description }).check(Schema.isMinLength(1), Schema.isMaxLength(max))
const optional = (description: string, max: number) =>
  Schema.optionalKey(required(description, max))
const clearable = (description: string, max: number) =>
  Schema.optionalKey(Schema.String.annotate({ description }).check(Schema.isMaxLength(max)))
const when = (description: string) => required(`${description} Given as ${WHEN}.`, 64)

const ref = (description: string) =>
  Schema.String.annotate({ description }).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1_024),
    Schema.isPattern(/^[^-]/u)
  )
const eventRef = ref(
  "The event_ref of one event, exactly as mac_calendar_search, mac_calendar_create_event or mac_calendar_edit_event returned it. Each occurrence of a repeating event has its own."
)
const reminderRef = ref(
  "The reminder_ref of one reminder, exactly as mac_reminders_search or mac_reminders_create returned it."
)
const calendarId = (purpose: string) =>
  Schema.optionalKey(ref(`${purpose} An id from mac_calendar_list_calendars.`))
const listId = (purpose: string) =>
  Schema.optionalKey(ref(`${purpose} An id from mac_reminders_list_lists.`))
const ids = (description: string) =>
  Schema.optionalKey(
    Schema.Array(ref("One id."))
      .annotate({ description })
      .check(Schema.isMinLength(1), Schema.isMaxLength(50))
  )
const limit = (most: number, fallback: number) =>
  Schema.optionalKey(
    Schema.Int.annotate({
      description: `Most results to return, from 1 to ${most}. Defaults to ${fallback}.`
    }).check(Schema.isBetween({ minimum: 1, maximum: most }))
  )
const query = (description: string) => optional(description, 1_024)
const scope = Schema.optionalKey(
  Schema.Literals(["this", "future"]).annotate({
    description:
      'For a repeating event: "this" (default) changes only the occurrence event_ref names; "future" changes it and every later one. Ignored for a single event.'
  })
)
const repeat = (what: string) =>
  Schema.optionalKey(
    Schema.Literals(["daily", "weekly", "monthly", "yearly"]).annotate({
      description: `Makes the ${what} repeat: daily, weekly, monthly or yearly.`
    })
  )
const priority = Schema.optionalKey(
  Schema.Literals(["none", "low", "medium", "high"]).annotate({
    description: "Priority: none, low, medium or high."
  })
)
const title = (what: string) => required(`The ${what}'s title.`, 1_024)
const NOTES_MAX = 32_768
const LINK = "A full link, such as https://example.com."

export const CalendarSearchSchema = Schema.Struct({
  query: query("Text to find in an event's title, place or notes. Leave out to list every event."),
  from: Schema.optionalKey(when("Start of the window. Defaults to now.")),
  to: Schema.optionalKey(
    when("End of the window; a day includes that whole day. Defaults to 7 days after from.")
  ),
  calendar_ids: ids("Only these calendars: ids from mac_calendar_list_calendars."),
  limit: limit(500, 50)
})

export const EventReadSchema = Schema.Struct({ event_ref: eventRef })

export const EventCreateSchema = Schema.Struct({
  title: title("event"),
  start: when("When the event starts."),
  end: Schema.optionalKey(
    when(
      "When the event ends. Without it a timed event lasts 1 hour; for an all-day event it is the last day, inclusive."
    )
  ),
  all_day: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "true for an all-day event. A start given as a day already makes one."
    })
  ),
  calendar_id: calendarId("The calendar to add the event to; the Mac's default one if left out."),
  location: optional("Where the event is.", 2_048),
  notes: optional("Notes for the event.", NOTES_MAX),
  url: optional(`A link for the event. ${LINK}`, 2_048),
  repeat: repeat("event"),
  alert_minutes: Schema.optionalKey(
    Schema.Int.annotate({
      description: "Alert the owner this many minutes before the start, from 0 to 40320."
    }).check(Schema.isBetween({ minimum: 0, maximum: 40_320 }))
  )
})

export const EventEditSchema = Schema.Struct({
  event_ref: eventRef,
  title: Schema.optionalKey(title("event")),
  start: Schema.optionalKey(when("The new start. Alone it moves the event and keeps its length.")),
  end: Schema.optionalKey(when("The new end.")),
  calendar_id: calendarId("Move the event to this calendar."),
  location: clearable("The new place. Empty removes it.", 2_048),
  notes: clearable("The new notes, replacing the old. Empty removes them.", NOTES_MAX),
  url: clearable(`The new link. ${LINK} Empty removes it.`, 2_048),
  scope
})

export const EventDeleteSchema = Schema.Struct({ event_ref: eventRef, scope })

export const ReminderSearchParametersSchema = Schema.Struct({
  query: query("Text to find in a reminder's title or notes. Leave out to list every reminder."),
  list_ids: ids("Only these lists: ids from mac_reminders_list_lists."),
  completed: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "true lists finished reminders in place of open ones."
    })
  ),
  due_before: Schema.optionalKey(
    when(
      "Only reminders due before this; a day includes that whole day. Leaves out reminders with no due date."
    )
  ),
  limit: limit(500, 50)
})

export const ReminderCreateSchema = Schema.Struct({
  title: title("reminder"),
  due: Schema.optionalKey(when("When it is due. With a time, the Mac alerts the owner then.")),
  list_id: listId("The list to add it to; the Mac's default one if left out."),
  notes: optional("Notes for the reminder.", NOTES_MAX),
  priority,
  url: optional(`A link for the reminder. ${LINK}`, 2_048),
  repeat: repeat("reminder (needs due)")
})

export const ReminderEditSchema = Schema.Struct({
  reminder_ref: reminderRef,
  title: Schema.optionalKey(title("reminder")),
  due: clearable(`The new due date or time, given as ${WHEN}. Empty removes it.`, 64),
  list_id: listId("Move the reminder to this list."),
  notes: clearable("The new notes, replacing the old. Empty removes them.", NOTES_MAX),
  priority,
  url: clearable(`The new link. ${LINK} Empty removes it.`, 2_048)
})

export const ReminderCompleteSchema = Schema.Struct({
  reminder_ref: reminderRef,
  reopen: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "true marks a finished reminder as not done again." })
  )
})

export const ReminderDeleteSchema = Schema.Struct({ reminder_ref: reminderRef })

export const ContactSearchParametersSchema = Schema.Struct({
  query: ref("A name, an email address or a phone number. It cannot start with a dash."),
  limit: limit(100, 20)
})

export const ContactReadSchema = Schema.Struct({
  contact_ref: ref("The contact_ref of one contact, exactly as mac_contacts_search returned it.")
})
