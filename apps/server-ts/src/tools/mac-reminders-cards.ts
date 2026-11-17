import type { ServerApprovalPrompt } from "./define.js"
import {
  calendarWords,
  record,
  ReminderRecordSchema,
  repeatWords,
  titleOf,
  type MacApps,
  type MacReminderRecord
} from "./mac-apps-records.js"
import type {
  ReminderCompleteSchema,
  ReminderCreateSchema,
  ReminderDeleteSchema,
  ReminderEditSchema
} from "./mac-apps-schemas.js"
import {
  changeablePlace,
  changedField,
  notesBody,
  targetData,
  writableTarget
} from "./mac-calendar-cards.js"
import { toolRefusal } from "./tool-failure.js"

export const readReminder = async (
  { helper }: MacApps,
  reminderRef: string,
  signal: AbortSignal
): Promise<MacReminderRecord> =>
  record(ReminderRecordSchema, await helper.run(["reminders", "get", reminderRef], { signal }))

export const reminderChanges = (input: typeof ReminderEditSchema.Type): void => {
  const changed = Object.entries(input).some(
    ([key, value]) => key !== "reminder_ref" && value !== undefined
  )
  if (!changed) throw toolRefusal("Provide at least one reminder change.", "No reminder changes")
}

const PRIORITY_WORDS: Readonly<Record<string, string>> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High"
}

const priorityWords = (priority: string | undefined): string | undefined =>
  priority !== undefined && Object.hasOwn(PRIORITY_WORDS, priority)
    ? PRIORITY_WORDS[priority]
    : priority

const optionalField = (label: string, value: string | undefined) =>
  value === undefined || value === "" ? [] : [{ label, value }]

export const makeMacRemindersCards = (apps: MacApps) => {
  const { words } = apps
  /** The reminder as it is now: what a card names before it is finished or deleted. */
  const context = (current: MacReminderRecord) => [
    { label: "Title", value: titleOf(current) },
    ...optionalField("Due", current.due === undefined ? undefined : words(current.due)),
    ...optionalField("List", current.list),
    ...optionalField(
      "Repeats",
      current.repeats === undefined ? undefined : repeatWords(current.repeats)
    ),
    ...optionalField("Priority", priorityWords(current.priority))
  ]
  const createCard = async (
    input: typeof ReminderCreateSchema.Type,
    signal: AbortSignal
  ): Promise<ServerApprovalPrompt> => {
    if (input.repeat !== undefined && input.due === undefined) {
      throw toolRefusal("A repeating reminder needs due.", "Repeat needs a due date")
    }
    const list = await writableTarget(apps, "list", input.list_id, signal)
    return {
      ...targetData(list),
      preview: `Add ${input.title}`,
      presentation: {
        title: "Add this reminder?",
        approve_label: "Add reminder",
        fields: [
          { label: "Title", value: input.title },
          ...optionalField("Due", input.due === undefined ? undefined : words(input.due)),
          ...optionalField("List", list === undefined ? undefined : calendarWords(list)),
          ...optionalField(
            "Repeats",
            input.repeat === undefined ? undefined : repeatWords(input.repeat)
          ),
          ...optionalField(
            "Priority",
            input.priority === "none" ? undefined : priorityWords(input.priority)
          ),
          ...optionalField("Link", input.url)
        ],
        ...notesBody(undefined, input.notes)
      }
    }
  }
  const editCard = async (
    input: typeof ReminderEditSchema.Type,
    signal: AbortSignal
  ): Promise<ServerApprovalPrompt> => {
    reminderChanges(input)
    const current = await readReminder(apps, input.reminder_ref, signal)
    const moved = await changeablePlace(
      apps,
      "list",
      { title: current.list },
      input.list_id,
      signal
    )
    return {
      preview: `Edit ${input.title ?? titleOf(current)}`,
      presentation: {
        title: "Change this reminder?",
        // The document card heads itself with the subject when no field is the title.
        subject: titleOf(current),
        approve_label: "Save changes",
        fields: [
          ...(input.title === undefined
            ? []
            : [{ label: "Title", value: input.title, from: titleOf(current) }]),
          ...changedField(
            "Due",
            input.due === undefined || input.due === "" ? input.due : words(input.due),
            current.due === undefined ? undefined : words(current.due),
            "Remove due date"
          ),
          ...changedField(
            "List",
            moved === undefined ? undefined : calendarWords(moved),
            current.list,
            ""
          ),
          ...optionalField(
            "Repeats",
            current.repeats === undefined ? undefined : repeatWords(current.repeats)
          ),
          ...changedField(
            "Priority",
            priorityWords(input.priority),
            priorityWords(current.priority),
            ""
          ),
          ...changedField("Link", input.url, current.url, "Remove link")
        ],
        ...notesBody(current.notes, input.notes)
      }
    }
  }
  const completeCard = async (
    input: typeof ReminderCompleteSchema.Type,
    signal: AbortSignal
  ): Promise<ServerApprovalPrompt> => {
    const current = await readReminder(apps, input.reminder_ref, signal)
    await changeablePlace(apps, "list", { title: current.list }, undefined, signal)
    const reopen = input.reopen === true
    return {
      preview: `${reopen ? "Reopen" : "Mark done"} ${titleOf(current)}`,
      presentation: {
        title: reopen ? "Reopen this reminder?" : "Mark this reminder done?",
        approve_label: reopen ? "Reopen" : "Mark done",
        fields: context(current),
        ...(reopen || current.repeats === undefined
          ? {}
          : { note: "It repeats: this occurrence is done and it moves to its next due date." }),
        ...notesBody(current.notes, undefined)
      }
    }
  }
  const deleteCard = async (
    input: typeof ReminderDeleteSchema.Type,
    signal: AbortSignal
  ): Promise<ServerApprovalPrompt> => {
    const current = await readReminder(apps, input.reminder_ref, signal)
    await changeablePlace(apps, "list", { title: current.list }, undefined, signal)
    return {
      preview: `Delete ${titleOf(current)}`,
      presentation: {
        title: "Delete this reminder?",
        approve_label: "Delete",
        fields: context(current),
        ...(current.repeats === undefined
          ? {}
          : { note: "It repeats: this deletes the reminder and every later occurrence." }),
        ...notesBody(current.notes, undefined)
      }
    }
  }
  return { createCard, editCard, completeCard, deleteCard }
}
