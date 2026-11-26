import { countOf } from "@arden-hq/std/count"
import { utcDay } from "@arden-hq/std/time"

import type { ServerApprovalPrompt } from "./define.js"
import {
  alertWords,
  CalendarListSchema,
  calendarWords,
  eventTimeFields,
  EventRecordSchema,
  isDay,
  record,
  repeatWords,
  titleOf,
  type LocalClock,
  type MacApps,
  type MacCalendarRecord,
  type MacEventRecord
} from "./mac-apps-records.js"
import type { EventCreateSchema, EventDeleteSchema, EventEditSchema } from "./mac-apps-schemas.js"
import { toolRefusal } from "./tool-failure.js"

type Field = { readonly label: string; readonly value: string; readonly from?: string }

export const readEvent = async (
  { helper }: MacApps,
  eventRef: string,
  signal: AbortSignal
): Promise<MacEventRecord> =>
  record(EventRecordSchema, await helper.run(["calendar", "get", eventRef], { signal }))

type Place = "calendar" | "list"
const LISTING = { calendar: "mac_calendar_list_calendars", list: "mac_reminders_list_lists" }

const places = async (
  { helper }: MacApps,
  kind: Place,
  signal: AbortSignal
): Promise<ReadonlyArray<MacCalendarRecord>> =>
  record(
    CalendarListSchema,
    await helper.run(kind === "calendar" ? ["calendar", "list"] : ["reminders", "lists"], {
      signal
    })
  )

/**
 * The calendar or Reminders list a new or moved item goes to: the one `id`
 * names, else the Mac's default. Refused here, before any card, when the
 * helper would refuse it after one.
 */
const pickTarget = (
  all: ReadonlyArray<MacCalendarRecord>,
  kind: Place,
  id: string | undefined
): MacCalendarRecord | undefined => {
  const found = all.find((item) => (id === undefined ? item.default : item.id === id))
  if (found === undefined && id !== undefined) {
    throw toolRefusal(`No ${kind} has the id ${id}. Take one from ${LISTING[kind]}.`, "Not found")
  }
  if (found !== undefined && !found.writable) {
    throw toolRefusal(
      `The ${kind} "${found.title}" is read-only. Pick another one from ${LISTING[kind]}.`,
      "Read-only"
    )
  }
  return found
}

export const writableTarget = async (
  apps: MacApps,
  kind: Place,
  id: string | undefined,
  signal: AbortSignal
): Promise<MacCalendarRecord | undefined> => pickTarget(await places(apps, kind, signal), kind, id)

/**
 * Refuses a change to an item whose calendar or list is read-only, before any
 * card, and returns where a `moveTo` id leads. A reminder names its list by
 * title only, so it is refused when every list of that title is read-only.
 */
export const changeablePlace = async (
  apps: MacApps,
  kind: Place,
  current: { readonly id?: string | undefined; readonly title: string },
  moveTo: string | undefined,
  signal: AbortSignal
): Promise<MacCalendarRecord | undefined> => {
  const all = await places(apps, kind, signal)
  const holding = all.filter((item) =>
    current.id === undefined ? item.title === current.title : item.id === current.id
  )
  if (holding.length > 0 && holding.every((item) => !item.writable)) {
    throw toolRefusal(
      `The ${kind} "${current.title}" is read-only, so nothing in it can be changed from here.`,
      "Read-only"
    )
  }
  return moveTo === undefined ? undefined : pickTarget(all, kind, moveTo)
}

const APPROVED_TARGET = "mac_target"

/** The calendar or list the card named, kept with the approval so the run uses the same one. */
export const targetData = (
  target: MacCalendarRecord | undefined
): { data?: never } | { data: { mac_target: string } } =>
  target === undefined ? {} : { data: { [APPROVED_TARGET]: target.id } }

export const newItemTarget = async (
  apps: MacApps,
  kind: Place,
  input: {
    readonly id: string | undefined
    readonly approval: { readonly data?: Readonly<Record<string, unknown>> | undefined } | undefined
  },
  signal: AbortSignal
): Promise<string | undefined> => {
  const approved = input.approval?.data?.[APPROVED_TARGET]
  if (input.id !== undefined) return input.id
  return typeof approved === "string"
    ? approved
    : (await writableTarget(apps, kind, undefined, signal))?.id
}

/** A field an edit may replace or clear: the new value over the old, or the old one alone. */
export const changedField = (
  label: string,
  next: string | undefined,
  before: string | undefined,
  cleared: string
): ReadonlyArray<Field> => {
  if (next === undefined) return before === undefined ? [] : [{ label, value: before }]
  if (next === "" && before === undefined) return []
  return [
    {
      label,
      value: next === "" ? cleared : next,
      ...(before === undefined ? {} : { from: before })
    }
  ]
}

export const notesBody = (
  before: string | undefined,
  next: string | undefined
): { body?: never } | { body: { before?: string; label: string; text: string } } => {
  const text = next === "" ? "Remove notes" : (next ?? before)
  if (text === undefined || (next === "" && before === undefined)) return {}
  return {
    body: {
      label: "Notes",
      text,
      ...(next === undefined || before === undefined ? {} : { before })
    }
  }
}

/** all_day with a time would land on this Mac's local day, not the day the text names. */
export const newEventAllDay = (input: {
  readonly start: string
  readonly end?: string | undefined
  readonly all_day?: boolean | undefined
}): boolean => {
  const days = isDay(input.start) && (input.end === undefined || isDay(input.end))
  if (input.all_day === true && !days) {
    throw toolRefusal(
      "With all_day, give start and end as days, such as 2026-11-18.",
      "Invalid event time"
    )
  }
  return days
}

/**
 * The times an edit leaves the event with, by the helper's own rules: start
 * and end share one form, a change of form needs both, and a new start alone
 * moves the event and keeps its length.
 */
export const editedEventTimes = (
  clock: LocalClock,
  current: MacEventRecord,
  input: { readonly start?: string | undefined; readonly end?: string | undefined }
): { readonly start: string; readonly end: string; readonly all_day: boolean } | undefined => {
  const given = [input.start, input.end].filter((value) => value !== undefined)
  const [first] = given
  if (first === undefined) return undefined
  const allDay = isDay(first)
  if (given.some((value) => isDay(value) !== allDay)) {
    throw toolRefusal("Give start and end both as days or both as times.", "Invalid event time")
  }
  if (allDay !== current.all_day && given.length < 2) {
    throw toolRefusal(
      current.all_day
        ? "This is an all-day event. To give it times, pass both start and end as times."
        : "This event has times. To make it all-day, pass both start and end as days.",
      "Invalid event time"
    )
  }
  const start = input.start ?? current.start
  if (input.end !== undefined) return { start, end: input.end, all_day: allDay }
  if (allDay) {
    const end = Date.parse(start) + Date.parse(current.end) - Date.parse(current.start)
    return { start, end: Number.isFinite(end) ? utcDay(end) : current.end, all_day: true }
  }
  const end = clock.instant(start) + Date.parse(current.end) - Date.parse(current.start)
  // The helper refuses a start it cannot read; the card then shows the end as it is.
  return {
    start,
    end: Number.isFinite(end) ? clock.localTime(end) : current.end,
    all_day: false
  }
}

export const eventChanges = (input: typeof EventEditSchema.Type): void => {
  const changed = Object.entries(input).some(
    ([key, value]) => key !== "event_ref" && key !== "scope" && value !== undefined
  )
  if (!changed) throw toolRefusal("Provide at least one event change.", "No event changes")
}

/**
 * The helper's span for a change, or nothing for a single event. An event is
 * part of a series when it repeats or is one changed occurrence, and the
 * helper marks both by a start after the last bar of the reference.
 */
export const eventSpan = (
  current: MacEventRecord,
  scope: "this" | "future" | undefined
): "this" | "future" | undefined =>
  current.repeats === undefined && !current.id.includes("|") ? undefined : (scope ?? "this")

const scopeFields = (
  current: MacEventRecord,
  scope: "this" | "future" | undefined
): ReadonlyArray<Field> => {
  const span = eventSpan(current, scope)
  if (span === undefined) return []
  return [
    { label: "Applies to", value: span === "future" ? "This and later events" : "This event only" }
  ]
}

/** The other people on an event, and that its account may write to them. */
const guestParts = (current: MacEventRecord, what: string) => {
  const others = (current.guest_list ?? []).filter((guest) => guest.you !== true)
  const named = others.flatMap((guest) => guest.name ?? guest.email ?? [])
  const count = current.guest_list === undefined ? (current.guests ?? 0) : others.length
  if (count === 0) return { fields: [], note: {} }
  return {
    fields: [
      {
        label: "Guests",
        value: named.length === count ? named.join(", ") : countOf(count, "guest")
      }
    ],
    note: { note: `The calendar's account may tell the guests about this ${what}.` }
  }
}

const optionalField = (label: string, value: string | undefined): ReadonlyArray<Field> =>
  value === undefined || value === "" ? [] : [{ label, value }]

export interface MacCalendarCards {
  readonly createCard: (
    input: typeof EventCreateSchema.Type,
    signal: AbortSignal
  ) => Promise<ServerApprovalPrompt>
  readonly editCard: (
    input: typeof EventEditSchema.Type,
    signal: AbortSignal
  ) => Promise<ServerApprovalPrompt>
  readonly deleteCard: (
    input: typeof EventDeleteSchema.Type,
    signal: AbortSignal
  ) => Promise<ServerApprovalPrompt>
}

export const makeMacCalendarCards = (apps: MacApps): MacCalendarCards => {
  const { words } = apps
  const createCard = async (
    input: typeof EventCreateSchema.Type,
    signal: AbortSignal
  ): Promise<ServerApprovalPrompt> => {
    const allDay = newEventAllDay(input)
    const calendar = await writableTarget(apps, "calendar", input.calendar_id, signal)
    return {
      ...targetData(calendar),
      preview: `Create ${input.title}`,
      presentation: {
        title: "Create this event?",
        approve_label: "Create event",
        fields: [
          { label: "Title", value: input.title },
          ...eventTimeFields({ start: input.start, end: input.end, all_day: allDay }, words),
          ...(allDay || input.end !== undefined
            ? []
            : [{ label: "Ends", value: "1 hour after the start" }]),
          ...optionalField(
            "Calendar",
            calendar === undefined ? undefined : calendarWords(calendar)
          ),
          ...optionalField(
            "Repeats",
            input.repeat === undefined ? undefined : repeatWords(input.repeat)
          ),
          ...optionalField("Where", input.location),
          ...optionalField(
            "Alert",
            input.alert_minutes === undefined ? undefined : alertWords(input.alert_minutes)
          ),
          ...optionalField("Link", input.url)
        ],
        ...notesBody(undefined, input.notes)
      }
    }
  }
  const editCard = async (
    input: typeof EventEditSchema.Type,
    signal: AbortSignal
  ): Promise<ServerApprovalPrompt> => {
    eventChanges(input)
    const current = await readEvent(apps, input.event_ref, signal)
    const times = editedEventTimes(apps.clock, current, input)
    const before = eventTimeFields(current, words)
    const moved = await changeablePlace(
      apps,
      "calendar",
      { id: current.calendar_id, title: current.calendar },
      input.calendar_id,
      signal
    )
    const guests = guestParts(current, "change")
    return {
      preview: `Edit ${input.title ?? titleOf(current)}`,
      presentation: {
        title: "Change this event?",
        approve_label: "Save changes",
        fields: [
          { label: "Event", value: titleOf(current) },
          ...scopeFields(current, input.scope),
          ...(input.title === undefined
            ? []
            : [{ label: "Title", value: input.title, from: titleOf(current) }]),
          ...(times === undefined
            ? before
            : eventTimeFields(times, words).map((field) => {
                const from = before.find((previous) => previous.label === field.label)?.value
                return from === undefined || from === field.value ? field : { ...field, from }
              })),
          ...changedField(
            "Calendar",
            moved === undefined ? undefined : calendarWords(moved),
            current.calendar,
            ""
          ),
          ...optionalField(
            "Repeats",
            current.repeats === undefined ? undefined : repeatWords(current.repeats)
          ),
          ...changedField("Where", input.location, current.location, "Remove place"),
          ...changedField("Link", input.url, current.url, "Remove link"),
          ...guests.fields
        ],
        ...guests.note,
        ...notesBody(current.notes, input.notes)
      }
    }
  }
  const deleteCard = async (
    input: typeof EventDeleteSchema.Type,
    signal: AbortSignal
  ): Promise<ServerApprovalPrompt> => {
    const current = await readEvent(apps, input.event_ref, signal)
    await changeablePlace(
      apps,
      "calendar",
      { id: current.calendar_id, title: current.calendar },
      undefined,
      signal
    )
    const guests = guestParts(current, "deletion")
    return {
      preview: `Delete ${titleOf(current)}`,
      presentation: {
        title: "Delete this event?",
        approve_label: "Delete event",
        fields: [
          { label: "Title", value: titleOf(current) },
          ...eventTimeFields(current, words),
          ...scopeFields(current, input.scope),
          ...optionalField("Calendar", current.calendar),
          ...optionalField(
            "Repeats",
            current.repeats === undefined ? undefined : repeatWords(current.repeats)
          ),
          ...optionalField("Where", current.location),
          ...guests.fields
        ],
        ...guests.note,
        ...notesBody(current.notes, undefined)
      }
    }
  }
  return { createCard, editCard, deleteCard }
}
