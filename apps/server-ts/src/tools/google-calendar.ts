import { type ServerTool } from "./define.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import { Schema } from "effect"
import { randomUUID } from "node:crypto"

import { accountEmail, connectedAccountEmails } from "./google-accounts.js"
import { googleCall } from "./google-request.js"
import { allDayText, event, eventData, meetLink, namedEvent } from "./google-calendar-events.js"
import {
  createParametersSchema,
  DeleteParametersSchema,
  EditParametersSchema,
  RespondParametersSchema
} from "./google-calendar-schemas.js"
import {
  calendarEventsUrl,
  calendarEventTarget,
  calendarEventUrl,
  PRIMARY_CALENDAR
} from "../google/calendar-client.js"
import {
  checkRecurrence,
  notifiedGuests,
  reminderBody,
  sendUpdatesFor
} from "./google-calendar-rules.js"
import { makeCalendarLookupTools } from "./google-calendar-lookup.js"
import { defineGoogleTool } from "./google-tool-grant.js"
import { makeCalendarCards } from "./google-calendar-cards.js"
import {
  calendarAttachmentsForExecution,
  calendarAttachmentBody
} from "./google-calendar-attachments.js"
import { calendarWriteGrant } from "./google-calendar-access.js"
import {
  currentEvent,
  eventTimes,
  meetRequest,
  parseEventRef,
  RESPONSE_WORDS,
  rsvpFor,
  scopeText,
  validEmail,
  whenText
} from "./google-calendar-support.js"
import { toolRefusal } from "./tool-failure.js"
import { makeCalendarReadTools } from "./google-calendar-read.js"

export const makeCalendarTools = ({
  google
}: {
  readonly google: GoogleToolConnections
}): ReadonlyArray<ServerTool> => {
  const emails = connectedAccountEmails(google, "calendar")
  const CreateParametersSchema = createParametersSchema(emails)
  const { createCard, editCard, deleteCard, respondCard } = makeCalendarCards(google)
  return [
    ...makeCalendarReadTools({ google, emails }),
    defineGoogleTool({
      google,
      grant: calendarWriteGrant({
        google,
        target: (input: typeof CreateParametersSchema.Type) => ({
          accountRef: input.account_ref,
          calendarId: input.calendar_id ?? PRIMARY_CALENDAR
        })
      }),
      name: "calendar_create_event",
      summary: "Adds an event to your calendar.",
      discovery: { group: "calendar" },
      description: [
        "Create an event in a connected account's Google Calendar (the primary one unless calendar_id names a calendar you may write to); attendees receive invitations.",
        "Timed by default; all_day makes it an all-day event on dates. recurrence makes it repeat, add_meet adds a Google Meet link, reminders sets popup reminders, attachments attaches Drive files.",
        "A calendar other than primary needs a one-time user grant so Arden can check your access."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(CreateParametersSchema),
      metadata: {
        effect: "external",
        display_name: "Create Calendar Event",
        display: [{ fact: "card", value: "calendar" }],
        kind: "tool",
        action: "write",
        approval_preview: "Create this Calendar event.",
        source: "calendar",
        changes_state: true,
        concurrency_group: "calendar_write",
        destructive: false,
        default_approval: "ask",
        policy_scope: "external",
        permissions: ["calendar"],
        idempotent: false,
        target: "reported"
      },
      approvalPrompt: (input, ctx) => createCard(input, ctx.signal),
      execute: async (input, ctx, effects) => {
        const attachments =
          input.attachments === undefined
            ? undefined
            : await calendarAttachmentsForExecution({
                google,
                request: input,
                refs: input.attachments,
                signal: ctx.signal,
                approval: ctx.approval
              })
        const calendarId = input.calendar_id ?? PRIMARY_CALENDAR
        if (input.attendees.some((email) => !validEmail(email))) {
          throw toolRefusal("Every attendee must be a valid email address.", "Invalid attendee")
        }
        const allDay = input.all_day === true
        const times = eventTimes(
          { allDay, start: input.start, end: input.end, timezone: input.timezone },
          false
        )
        const recurrence = input.recurrence === undefined ? [] : checkRecurrence(input.recurrence)
        if (recurrence.length > 0 && !allDay && input.timezone === undefined) {
          throw toolRefusal(
            "A repeating timed event needs timezone, an IANA name such as America/New_York.",
            "Recurrence needs a time zone"
          )
        }
        const guests = notifiedGuests({
          account: accountEmail(google, input.account_ref),
          current: [],
          replacement: input.attendees
        })
        const url = calendarEventsUrl(calendarId)
        url.searchParams.set("sendUpdates", sendUpdatesFor(guests))
        if (attachments !== undefined) url.searchParams.set("supportsAttachments", "true")
        if (input.add_meet === true) url.searchParams.set("conferenceDataVersion", "1")
        // Google accepts a caller-chosen event id in base32hex, which hex lies within: https://developers.google.com/workspace/calendar/api/v3/reference/events
        const eventId = randomUUID().replaceAll("-", "")
        await effects.target(
          { ...calendarEventTarget(eventId), title: input.title },
          { creates: true }
        )
        const response = await googleCall({
          google,
          service: "calendar",
          url: url.href,
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: eventId,
              ...(attachments === undefined
                ? {}
                : { attachments: calendarAttachmentBody(attachments.attachments) }),
              summary: input.title,
              ...times,
              ...(input.description === undefined ? {} : { description: input.description }),
              ...(input.location === undefined ? {} : { location: input.location }),
              ...(input.attendees.length === 0
                ? {}
                : { attendees: input.attendees.map((email) => ({ email })) }),
              ...(recurrence.length === 0 ? {} : { recurrence }),
              ...(input.add_meet === true ? { conferenceData: meetRequest() } : {}),
              ...(input.reminders === undefined ? {} : { reminders: reminderBody(input.reminders) })
            })
          },
          accountRef: input.account_ref,
          signal: ctx.signal,
          effects
        })
        const created = event(response.value)
        await effects.created(namedEvent(created))
        const data = eventData(created, response.account.email, calendarId)
        return {
          result: [
            `Created Calendar event: ${data.title}`,
            allDayText(data) ?? `${data.start} — ${data.end}`,
            ...(input.add_meet !== true
              ? []
              : [
                  data.meet_link === null
                    ? "Google is still creating the Meet link; read the event again shortly."
                    : `Meet: ${data.meet_link}`
                ]),
            `Reference: ${data.event_ref}`
          ].join("\n"),
          preview: `Created ${data.title}`,
          data
        }
      }
    }),
    defineGoogleTool({
      google,
      grant: calendarWriteGrant({
        google,
        target: (input: typeof EditParametersSchema.Type) => {
          const ref = parseEventRef(input.event_ref, input.calendar_id)
          return { accountRef: ref.account, calendarId: ref.calendarId }
        }
      }),
      name: "calendar_edit_event",
      summary: "Changes a calendar event.",
      discovery: { group: "calendar" },
      description: [
        "Partially edit the event identified by calendar_search (on whichever calendar its event_ref names); time changes require both start and end (all_day: dates, end optional), and providing attendees replaces the list.",
        "Guests other than the user are emailed about any edit.",
        'On a recurring event scope "this" (default) edits one occurrence and "series" all of them.',
        "add_meet adds a Google Meet link; reminders replaces the popup reminders; add_attachments and remove_attachments change attached Drive files.",
        "A calendar other than primary needs a one-time user grant so Arden can check your access."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(EditParametersSchema),
      metadata: {
        effect: "external",
        display_name: "Edit Calendar Event",
        display: [{ fact: "card", value: "calendar" }],
        kind: "tool",
        action: "write",
        approval_preview: "Edit this Calendar event.",
        source: "calendar",
        changes_state: true,
        concurrency_group: "calendar_write",
        destructive: false,
        default_approval: "ask",
        policy_scope: "external",
        permissions: ["calendar"],
        idempotent: true,
        target: "reported"
      },
      approvalPrompt: (input, ctx) => editCard(input, ctx.signal),
      execute: async (input, ctx, effects) => {
        const ref = parseEventRef(input.event_ref, input.calendar_id)
        const fields = Object.entries(input).filter(
          ([key, value]) =>
            key !== "event_ref" && key !== "scope" && key !== "calendar_id" && value !== undefined
        )
        if (fields.length === 0)
          throw toolRefusal("Provide at least one event change.", "No event changes")
        if (input.attendees?.some((email) => !validEmail(email))) {
          throw toolRefusal("Every attendee must be a valid email address.", "Invalid attendee")
        }
        const allDay = input.all_day === true
        if (input.start === undefined && (input.end !== undefined || allDay)) {
          throw toolRefusal("Edit start and end together.", "Incomplete event time")
        }
        if (input.start !== undefined && input.end === undefined && !allDay) {
          throw toolRefusal("Edit start and end together.", "Incomplete event time")
        }
        if (input.timezone !== undefined && input.start === undefined) {
          throw toolRefusal("Edit timezone together with start and end.", "Incomplete event time")
        }
        const times =
          input.start === undefined
            ? {}
            : eventTimes(
                { allDay, start: input.start, end: input.end, timezone: input.timezone },
                true
              )
        const current = await currentEvent(google, ref, input.scope ?? "this", ctx.signal)
        const { targetId } = current
        const attachments =
          input.add_attachments === undefined && input.remove_attachments === undefined
            ? undefined
            : await calendarAttachmentsForExecution({
                google,
                request: input,
                refs: input.add_attachments ?? [],
                remove: input.remove_attachments ?? [],
                current: current.target,
                signal: ctx.signal,
                approval: ctx.approval
              })
        const notified = notifiedGuests({
          account: current.account,
          current: current.target.attendees ?? [],
          replacement: input.attendees
        })
        const addMeet = input.add_meet === true && meetLink(current.target) === null
        const body = {
          ...(attachments === undefined
            ? {}
            : { attachments: calendarAttachmentBody(attachments.attachments) }),
          ...(input.title === undefined ? {} : { summary: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.location === undefined ? {} : { location: input.location }),
          ...times,
          ...(input.attendees === undefined
            ? {}
            : { attendees: input.attendees.map((email) => ({ email })) }),
          ...(input.reminders === undefined ? {} : { reminders: reminderBody(input.reminders) }),
          ...(addMeet ? { conferenceData: meetRequest() } : {})
        }
        const url = calendarEventUrl(targetId, ref.calendarId)
        url.searchParams.set("sendUpdates", sendUpdatesFor(notified))
        if (attachments !== undefined) url.searchParams.set("supportsAttachments", "true")
        if (addMeet) url.searchParams.set("conferenceDataVersion", "1")
        await effects.target(namedEvent(current.target))
        const response = await googleCall({
          google,
          service: "calendar",
          url: url.href,
          init: {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              ...(attachments?.etag === undefined ? {} : { "if-match": attachments.etag })
            },
            body: JSON.stringify(body)
          },
          accountRef: ref.account,
          signal: ctx.signal,
          effects
        })
        const updated = event(response.value)
        if (updated.id !== targetId) {
          throw toolRefusal(
            "Google Calendar returned a different event.",
            "Invalid Calendar response"
          )
        }
        const data = eventData(updated, response.account.email, ref.calendarId)
        return {
          result: [
            `Updated Calendar event: ${data.title}`,
            ...(scopeText(current.item, targetId) === "Every event in the series"
              ? ["Applied to every event in the series."]
              : []),
            ...(!addMeet
              ? []
              : [
                  data.meet_link === null
                    ? "Google is still creating the Meet link; read the event again shortly."
                    : `Meet: ${data.meet_link}`
                ])
          ].join("\n"),
          preview: `Updated ${data.title}`,
          data
        }
      }
    }),
    defineGoogleTool({
      google,
      grant: calendarWriteGrant({
        google,
        target: (input: typeof DeleteParametersSchema.Type) => {
          const ref = parseEventRef(input.event_ref, input.calendar_id)
          return { accountRef: ref.account, calendarId: ref.calendarId }
        }
      }),
      name: "calendar_delete_event",
      summary: "Removes a calendar event.",
      discovery: { group: "calendar" },
      description: [
        "Delete the event identified by calendar_search (on whichever calendar its event_ref names) and send cancellation updates to guests other than the user.",
        'On a recurring event scope "this" (default) deletes one occurrence and "series" the whole series.',
        "A calendar other than primary needs a one-time user grant so Arden can check your access."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(DeleteParametersSchema),
      metadata: {
        effect: "external",
        display_name: "Delete Calendar Event",
        display: [{ fact: "card", value: "calendar" }],
        kind: "tool",
        action: "write",
        approval_preview: "Delete this Calendar event.",
        source: "calendar",
        changes_state: true,
        concurrency_group: "calendar_write",
        destructive: true,
        default_approval: "ask",
        policy_scope: "external",
        permissions: ["calendar"],
        idempotent: true,
        target: "reported"
      },
      approvalPrompt: (input, ctx) => deleteCard(input, ctx.signal),
      execute: async (input, ctx, effects) => {
        const ref = parseEventRef(input.event_ref, input.calendar_id)
        const current = await currentEvent(google, ref, input.scope ?? "this", ctx.signal)
        const { targetId } = current
        const notified = notifiedGuests({
          account: current.account,
          current: current.target.attendees ?? []
        })
        const url = calendarEventUrl(targetId, ref.calendarId)
        url.searchParams.set("sendUpdates", sendUpdatesFor(notified))
        await effects.target(namedEvent(current.target))
        await googleCall({
          google,
          service: "calendar",
          url: url.href,
          init: { method: "DELETE" },
          accountRef: ref.account,
          signal: ctx.signal,
          effects
        })
        return {
          result:
            scopeText(current.item, targetId) === "Every event in the series"
              ? `Deleted every event in the series of ${input.event_ref}.`
              : `Deleted Calendar event ${input.event_ref}.`,
          preview: "Calendar event deleted",
          data: { event_ref: input.event_ref, account_ref: ref.account }
        }
      }
    }),
    defineGoogleTool({
      google,
      grant: calendarWriteGrant({
        google,
        target: (input: typeof RespondParametersSchema.Type) => {
          const ref = parseEventRef(input.event_ref, input.calendar_id)
          return { accountRef: ref.account, calendarId: ref.calendarId }
        }
      }),
      name: "calendar_respond",
      summary: "Answers a calendar invitation.",
      discovery: { group: "calendar" },
      description: [
        "Answer an invitation: accepted, declined or tentative, with an optional note to the organizer.",
        "Changes only your own response; the organizer is told. Refused if you were not invited or you are the organizer.",
        'On a recurring event scope "this" (default) answers one occurrence and "series" all of them.',
        "A calendar other than primary needs a one-time user grant so Arden can check your access."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(RespondParametersSchema),
      metadata: {
        effect: "external",
        display_name: "Answer Calendar Invitation",
        display: [{ fact: "card", value: "calendar" }],
        kind: "tool",
        action: "write",
        approval_preview: "Answer this Calendar invitation.",
        source: "calendar",
        changes_state: true,
        concurrency_group: "calendar_write",
        destructive: false,
        default_approval: "ask",
        policy_scope: "external",
        permissions: ["calendar"],
        idempotent: true,
        target: "reported"
      },
      approvalPrompt: (input, ctx) => respondCard(input, ctx.signal),
      execute: async (input, ctx, effects) => {
        const ref = parseEventRef(input.event_ref, input.calendar_id)
        const current = await currentEvent(google, ref, input.scope ?? "this", ctx.signal)
        const body = rsvpFor(current, input)
        const { targetId } = current
        const url = calendarEventUrl(targetId, ref.calendarId)
        url.searchParams.set("sendUpdates", "all")
        await effects.target(namedEvent(current.target))
        const response = await googleCall({
          google,
          service: "calendar",
          url: url.href,
          init: {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          },
          accountRef: ref.account,
          signal: ctx.signal,
          effects
        })
        const updated = event(response.value)
        const data = eventData(updated, response.account.email, ref.calendarId)
        return {
          result: [
            `${RESPONSE_WORDS[input.response].verb}: ${data.title}`,
            whenText(data),
            ...(scopeText(current.item, targetId) === "Every event in the series"
              ? ["Applied to every event in the series."]
              : []),
            ...(data.organizer === null ? [] : [`${data.organizer} was told.`])
          ].join("\n"),
          preview: `${RESPONSE_WORDS[input.response].verb} ${data.title}`,
          data
        }
      }
    }),
    ...makeCalendarLookupTools({ google })
  ]
}
