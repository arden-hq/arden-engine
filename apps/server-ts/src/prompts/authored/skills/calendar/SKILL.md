---
name: calendar
description: Find, create, edit and answer Google Calendar events, and check when people are free.
version: 1.4.0
tool_group: Calendar
---

# Calendar

## Workflow

- Search the relevant time window when conflicts, duplicates, or the target event matter.
- For an authorized change, call the corresponding Calendar tool with the intended event and guests. Arden's permission system decides whether to show an event approval card, execute directly or refuse. Do not invent a separate widget call or ask a second text confirmation before the card. A proposed meeting alone does not authorize creating an event or inviting guests.
- The tool result is the outcome after any card decision. Do not repeat the mutation after approval; inspect uncertain outcomes before retrying.
- Use the returned event_ref for edits or deletion. Time edits need both start and end.
- Attendee edits replace the whole list; omit attendees when they should remain unchanged. Any edit or delete emails the event's guests other than the user, and the approval card says how many.
- All-day events: all_day true with dates (YYYY-MM-DD); end is the last day, inclusive, and defaults to start. Search and read show them as dates.
- Repeating events: create takes recurrence lines such as RRULE:FREQ=WEEKLY;BYDAY=MO (a timed one also needs timezone). Search results name the series as recurring_event_id. Edit and delete take scope "this" (default, one occurrence) or "series" (all); there is no "this and following".
- add_meet true adds a Google Meet link; reminders is a list of popup minutes before the start (omit for the calendar defaults).
- Other calendars: calendar_list_calendars lists them with your role; pass an id as calendar_id to the event tools. A returned event_ref already names its calendar; calendar_id can also qualify an older primary-form reference, and must agree with a calendar-qualified reference. Events on a calendar where you are only a reader are never changed. Arden asks the user once before it lists calendars, or writes outside the primary one.
- Finding a time: calendar_free_busy takes calendars (ids or other people's emails) and a window; with find_slots (duration_minutes, the user's timezone, optional working_start and working_end) it also lists the stretches when every known calendar is free. A calendar marked unknown could not be read: never call it free, and tell the user whose calendar was not checked.
- Invitations: calendar_respond answers accepted, declined or tentative, with an optional note. It changes only the user's own response and tells the organizer. It does not work on events the user organizes or was not invited to.
- Calendar Automations: event_approaching (all-day events at 08:00 local), event_ended (timed events, soon after the end) and calendar.changed carry event.organizer and event.my_response (needsAction, accepted, declined, tentative), so "invites I have not answered" is event.my_response = needsAction. They cover the primary calendar and, once the user allowed listing calendars, every other selected calendar whose events they can read.
- For meeting requests from email, first use the relevant Gmail thread as evidence for participants and constraints.
- Read event attachment metadata before downloading anything. Use a returned file_ref with drive_download or drive_export when its contents are required.
- Create accepts attachments as Drive file_refs. Edits accept add_attachments and remove_attachments; removals use exact attachment_ref values from the event read. Other attachments stay in place. Upload a chat screenshot or local file with drive_upload first.
- Calendar attachments are links to Drive files. Use drive_share_file separately when the user wants guests to receive file access. A version conflict requires reading the event and requesting fresh approval before retrying.

## References and outcomes

- Reuse returned refs exactly and keep the account consistent. Paging refs belong to the query and account that produced them.
- Continue pagination when missing results could change the answer.
- Use the mutation result the service returns; read back when exact stored content matters. Inspect uncertain outcomes before retrying writes.
