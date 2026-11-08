import type { ServerApprovalPrompt } from "./define.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import { eventData } from "./google-calendar-events.js"
import {
  createParametersSchema,
  DeleteParametersSchema,
  EditParametersSchema,
  RespondParametersSchema
} from "./google-calendar-schemas.js"
import { PRIMARY_CALENDAR } from "../google/calendar-client.js"
import { notifiedGuests, notifyPhrase } from "./google-calendar-rules.js"
import {
  currentEvent,
  parseEventRef,
  reminderText,
  RESPONSE_WORDS,
  rsvpFor,
  scopeText,
  timeFields,
  calendarIdentityFields
} from "./google-calendar-support.js"
import {
  prepareCalendarAttachments,
  calendarAttachmentPresentation,
  calendarAttachmentRef,
  CALENDAR_ATTACHMENT_ACCESS_NOTE
} from "./google-calendar-attachments.js"

export const makeCalendarCards = (google: GoogleToolConnections) => {
  const createCard = async (
    input: ReturnType<typeof createParametersSchema>["Type"],
    signal: AbortSignal
  ): Promise<ServerApprovalPrompt> => {
    const attachments =
      input.attachments === undefined
        ? undefined
        : await prepareCalendarAttachments({
            google,
            request: input,
            refs: input.attachments,
            signal
          })
    return {
      ...(attachments === undefined ? {} : { data: { calendar_attachments: attachments } }),
      preview: `Create ${input.title}`,
      presentation: {
        title: "Create this event?",
        attachments: calendarAttachmentPresentation(attachments?.attachments ?? []),
        ...(attachments === undefined ? {} : { note: CALENDAR_ATTACHMENT_ACCESS_NOTE }),
        approve_label: input.attendees.length > 0 ? "Create and invite" : "Create event",
        fields: [
          ...calendarIdentityFields(input.account_ref, input.calendar_id ?? PRIMARY_CALENDAR),
          { label: "Title", value: input.title },
          ...timeFields(input),
          ...(input.recurrence === undefined || input.recurrence.length === 0
            ? []
            : [{ label: "Repeats", value: input.recurrence.join("; ") }]),
          ...(input.location === undefined ? [] : [{ label: "Where", value: input.location }]),
          ...(input.add_meet === true ? [{ label: "Meet", value: "Add a Google Meet link" }] : []),
          ...(input.reminders === undefined
            ? []
            : [{ label: "Reminders", value: reminderText(input.reminders) }]),
          ...(input.attendees.length === 0
            ? []
            : [{ label: "Invites", value: input.attendees.join(", ") }])
        ],
        ...(input.description === undefined
          ? {}
          : { body: { label: "Description", text: input.description } })
      }
    }
  }
  const editCard = async (
    input: typeof EditParametersSchema.Type,
    signal: AbortSignal
  ): Promise<ServerApprovalPrompt> => {
    const ref = parseEventRef(input.event_ref, input.calendar_id)
    const current = await currentEvent(google, ref, input.scope ?? "this", signal)
    const attachments =
      input.add_attachments === undefined && input.remove_attachments === undefined
        ? undefined
        : await prepareCalendarAttachments({
            google,
            request: input,
            refs: input.add_attachments ?? [],
            remove: input.remove_attachments ?? [],
            current: current.target,
            signal
          })
    const before = eventData(current.target, current.account, ref.calendarId)
    const previousTimes = timeFields({
      ...before,
      ...(current.target.start?.timeZone === undefined
        ? {}
        : { timezone: current.target.start.timeZone })
    })
    const notified = notifiedGuests({
      account: current.account,
      current: current.target.attendees ?? [],
      replacement: input.attendees
    })
    const scope = scopeText(current.item, current.targetId)
    return {
      ...(attachments === undefined ? {} : { data: { calendar_attachments: attachments } }),
      preview: input.title === undefined ? "Edit this Calendar event" : `Edit ${input.title}`,
      presentation: {
        title: "Change this event?",
        attachments: calendarAttachmentPresentation(
          attachments?.attachments ?? current.target.attachments ?? []
        ),
        ...(attachments === undefined ? {} : { note: CALENDAR_ATTACHMENT_ACCESS_NOTE }),
        approve_label: notified.length > 0 ? `Save and ${notifyPhrase(notified)}` : "Save changes",
        fields: [
          ...calendarIdentityFields(current.account, ref.calendarId),
          ...(input.remove_attachments === undefined
            ? []
            : [
                {
                  label: "Remove attachments",
                  value: (current.target.attachments ?? [])
                    .filter((file) =>
                      input.remove_attachments?.includes(calendarAttachmentRef(file))
                    )
                    .map((file) => file.title ?? file.fileUrl)
                    .join(", ")
                }
              ]),
          {
            label: "Event",
            value: before.title
          },
          ...(scope === undefined ? [] : [{ label: "Applies to", value: scope }]),
          ...(input.title === undefined
            ? []
            : [{ label: "Title", value: input.title, from: before.title }]),
          ...(input.start === undefined
            ? previousTimes
            : timeFields(input).map((field) => ({
                ...field,
                from: previousTimes.find((previous) => previous.label === field.label)?.value
              }))),
          ...(before.recurrence.length === 0
            ? []
            : [{ label: "Repeats", value: before.recurrence.join("; ") }]),
          ...(input.location === undefined
            ? optionalField("Where", before.location)
            : [
                {
                  label: "Where",
                  value: input.location || "Remove location",
                  from: before.location
                }
              ]),
          ...(input.add_meet === true
            ? [{ label: "Meet", value: "Add a Google Meet link" }]
            : optionalField("Meet", before.meet_link ?? "")),
          ...(input.reminders === undefined
            ? []
            : [{ label: "Reminders", value: reminderText(input.reminders) }]),
          ...(input.attendees === undefined
            ? optionalField("Guests", before.attendees.map((guest) => guest.email).join(", "))
            : [
                {
                  label: "Invites",
                  value:
                    input.attendees.length === 0 ? "Remove everyone" : input.attendees.join(", ")
                }
              ]),
          ...(notified.length === 0 ? [] : [{ label: "Notifies", value: notified.join(", ") }])
        ],
        ...descriptionBody(before.description, input.description)
      }
    }
  }
  const deleteCard = async (
    input: typeof DeleteParametersSchema.Type,
    signal: AbortSignal
  ): Promise<ServerApprovalPrompt> => {
    const ref = parseEventRef(input.event_ref, input.calendar_id)
    const current = await currentEvent(google, ref, input.scope ?? "this", signal)
    const data = eventData(current.target, current.account, ref.calendarId)
    const notified = notifiedGuests({
      account: current.account,
      current: current.target.attendees ?? []
    })
    const scope = scopeText(current.item, current.targetId)
    return {
      preview: `Delete ${data.title}`,
      presentation: {
        title: "Delete this event?",
        attachments: calendarAttachmentPresentation(current.target.attachments ?? []),
        approve_label:
          notified.length > 0 ? `Delete and ${notifyPhrase(notified)}` : "Delete event",
        fields: [
          ...calendarIdentityFields(current.account, ref.calendarId),
          { label: "Title", value: data.title },
          ...eventContext(data, current.target.start?.timeZone),
          ...(scope === undefined ? [] : [{ label: "Applies to", value: scope }]),
          ...(notified.length === 0 ? [] : [{ label: "Notifies", value: notified.join(", ") }])
        ],
        ...descriptionBody(data.description, undefined)
      }
    }
  }
  const respondCard = async (
    input: typeof RespondParametersSchema.Type,
    signal: AbortSignal
  ): Promise<ServerApprovalPrompt> => {
    const ref = parseEventRef(input.event_ref, input.calendar_id)
    const current = await currentEvent(google, ref, input.scope ?? "this", signal)
    rsvpFor(current, input)
    const data = eventData(current.target, current.account, ref.calendarId)
    const scope = scopeText(current.item, current.targetId)
    return {
      preview: `${RESPONSE_WORDS[input.response].verb} ${data.title}`,
      presentation: {
        title: `${RESPONSE_WORDS[input.response].verb} this invitation?`,
        attachments: calendarAttachmentPresentation(current.target.attachments ?? []),
        approve_label: RESPONSE_WORDS[input.response].button,
        fields: [
          ...calendarIdentityFields(current.account, ref.calendarId),
          { label: "Event", value: data.title },
          ...eventContext(data, current.target.start?.timeZone),
          ...(scope === undefined ? [] : [{ label: "Applies to", value: scope }]),
          ...(current.target.organizer?.email === undefined
            ? []
            : [{ label: "Notifies", value: current.target.organizer.email }]),
          { label: "Your answer", value: RESPONSE_WORDS[input.response].answer },
          ...(input.comment === undefined || input.comment === ""
            ? []
            : [{ label: "Note", value: input.comment }])
        ],
        ...descriptionBody(data.description, undefined)
      }
    }
  }
  return { createCard, editCard, deleteCard, respondCard }
}

const optionalField = (label: string, value: string) => (value === "" ? [] : [{ label, value }])

const descriptionBody = (before: string, replacement: string | undefined) => {
  const text = replacement === "" ? "Remove description" : (replacement ?? before)
  if (text === "") return {}
  return { body: { label: "Description", text, ...(replacement === undefined ? {} : { before }) } }
}

const eventContext = (data: ReturnType<typeof eventData>, timezone: string | undefined) => [
  ...timeFields({ ...data, timezone }),
  ...optionalField("Where", data.location),
  ...optionalField("Repeats", data.recurrence.join("; ")),
  ...optionalField("Meet", data.meet_link ?? ""),
  ...optionalField("Guests", data.attendees.map((guest) => guest.email).join(", ")),
  ...optionalField("Organizer", data.organizer ?? "")
]
