import { join } from "node:path"
import { PauseRequested, ToolExecutionError } from "@arden-hq/loop"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { readMutationReceipt } from "../src/persistence/tools/mutation-receipt.js"
import { makeMacAppsTools } from "../src/tools/mac-apps.js"
import {
  makeFakeMacHelper,
  type FakeMacAnswer,
  type FakeMacHelper
} from "./fixtures/fake-mac-helper.js"
import { serverRunContext } from "./kit.js"

const EVENT = {
  id: "EV-1|2026-11-18T09:30:00+04:00",
  title: "Dentist",
  all_day: false,
  start: "2026-11-18T09:30:00+04:00",
  end: "2026-11-18T10:15:00+04:00",
  calendar: "Home",
  calendar_id: "CAL-1",
  location: "12 Main St",
  repeats: "weekly",
  notes: "Bring the x-ray"
}
const REMINDER = {
  id: "REM-1",
  title: "Renew passport",
  list: "Errands",
  completed: false,
  due: "2026-11-20T18:00:00+04:00",
  priority: "high",
  repeats: "yearly"
}
const CALENDARS = [
  { id: "CAL-1", title: "Home", writable: true, default: true, account: "iCloud" },
  { id: "CAL-2", title: "Work", writable: true, default: false, account: "Exchange" },
  { id: "CAL-3", title: "Holidays", writable: false, default: false, account: "Other" }
]
const LISTS = [{ id: "LIST-1", title: "Errands", writable: true, default: true, account: "iCloud" }]

const ANSWERS: Record<string, FakeMacAnswer> = {
  "calendar list": { prints: CALENDARS },
  "calendar events": {
    prints: {
      from: "2026-11-18T00:00:00+04:00",
      to: "2026-11-26T00:00:00+04:00",
      events: [EVENT],
      more: false
    }
  },
  "calendar get": { prints: EVENT },
  "calendar create": { prints: { ...EVENT, id: "EV-2", title: "Lunch" } },
  "calendar update": { prints: EVENT },
  "calendar delete": { prints: { deleted: EVENT.id, title: "Dentist" } },
  "reminders lists": { prints: LISTS },
  "reminders list": { prints: { reminders: [REMINDER], more: false } },
  "reminders get": { prints: REMINDER },
  "reminders create": { prints: REMINDER },
  "reminders update": { prints: REMINDER },
  "reminders complete": { prints: REMINDER },
  "reminders delete": { prints: { deleted: "REM-1", title: "Renew passport" } },
  "contacts search": {
    prints: {
      contacts: [{ id: "C-1", name: "Sam Lee", emails: [{ value: "sam@example.com" }] }],
      more: false
    }
  },
  "contacts get": { prints: { id: "C-1", name: "Sam Lee" } }
}

let fake: FakeMacHelper
let directory = ""
let helper = ""

beforeAll(async () => {
  fake = await makeFakeMacHelper()
  directory = fake.directory
  helper = fake.path
})

afterAll(() => fake.remove())

const answer = (answers: typeof ANSWERS = {}) => fake.answer({ ...ANSWERS, ...answers })

beforeEach(async () => {
  await fake.forget()
  await answer()
})

const calls = () => fake.calls()

const tool = (name: string, options: Parameters<typeof makeMacAppsTools>[0] = {}) => {
  const found = makeMacAppsTools({
    path: helper,
    platform: "darwin",
    offsetMinutes: () => 240,
    ...options
  }).find((candidate) => candidate.definition.name === name)
  if (found === undefined) throw new Error(`no tool ${name}`)
  return found
}

const context = () => ({
  toolCallId: "call-1",
  signal: new AbortController().signal,
  run: serverRunContext(),
  messages: []
})

const run = (name: string, args: Record<string, unknown>) =>
  tool(name).execute(args, { ...context(), approval: { approved: true, feedback: null } })

const card = async (name: string, args: Record<string, unknown>) => {
  const pause = await tool(name)
    .execute(args, context(), { decision: "ask" })
    .then(
      () => undefined,
      (cause: unknown) => cause
    )
  if (pause instanceof PauseRequested) return pause.presentation
  throw pause ?? new Error(`${name} did not ask`)
}

describe("Mac app tools: the helper's arguments", () => {
  it("reads with the options the model gave", async () => {
    await run("mac_calendar_list_calendars", {})
    await run("mac_calendar_search", {
      query: "dentist",
      from: "2026-11-18",
      to: "2026-11-25",
      calendar_ids: ["CAL-1", "CAL-2"],
      limit: 5
    })
    await run("mac_calendar_read_event", { event_ref: EVENT.id })
    await run("mac_reminders_list_lists", {})
    await run("mac_reminders_search", {
      completed: true,
      due_before: "2026-11-20",
      list_ids: ["LIST-1"]
    })
    await run("mac_contacts_search", { query: "Sam Lee", limit: 3 })
    await run("mac_contacts_read", { contact_ref: "C-1" })
    expect(await calls()).toEqual([
      ["calendar", "list"],
      [
        "calendar",
        "events",
        "--from",
        "2026-11-18",
        "--to",
        "2026-11-25",
        "--calendar",
        "CAL-1",
        "--calendar",
        "CAL-2",
        "--query",
        "dentist",
        "--limit",
        "5"
      ],
      ["calendar", "get", EVENT.id],
      ["reminders", "lists"],
      ["reminders", "list", "--list", "LIST-1", "--completed", "--due-before", "2026-11-20"],
      ["contacts", "search", "Sam Lee", "--limit", "3"],
      ["contacts", "get", "C-1"]
    ])
  })

  it("changes Calendar after reading the event the change names", async () => {
    await run("mac_calendar_create_event", {
      title: "Lunch; rm -rf ~",
      start: "2026-11-18T12:00",
      end: "2026-11-18T13:00",
      calendar_id: "CAL-2",
      location: "Cafe",
      notes: "--span future",
      repeat: "weekly",
      alert_minutes: 30
    })
    await run("mac_calendar_create_event", { title: "Trip", start: "2026-12-02", all_day: true })
    await run("mac_calendar_edit_event", {
      event_ref: EVENT.id,
      start: "2026-11-19T09:30",
      location: "",
      scope: "future"
    })
    await run("mac_calendar_delete_event", { event_ref: EVENT.id })
    expect(await calls()).toEqual([
      [
        "calendar",
        "create",
        "--title",
        "Lunch; rm -rf ~",
        "--start",
        "2026-11-18T12:00",
        "--end",
        "2026-11-18T13:00",
        "--calendar",
        "CAL-2",
        "--location",
        "Cafe",
        "--notes",
        "--span future",
        "--repeat",
        "weekly",
        "--alert",
        "30"
      ],
      ["calendar", "list"],
      [
        "calendar",
        "create",
        "--title",
        "Trip",
        "--start",
        "2026-12-02",
        "--all-day",
        "--calendar",
        "CAL-1"
      ],
      ["calendar", "get", EVENT.id],
      [
        "calendar",
        "update",
        EVENT.id,
        "--start",
        "2026-11-19T09:30",
        "--location",
        "",
        "--span",
        "future"
      ],
      ["calendar", "get", EVENT.id],
      ["calendar", "delete", EVENT.id, "--span", "this"]
    ])
  })

  it("hands the model the reference and the item, and never takes a reference that reads as an option", async () => {
    const found = await run("mac_reminders_search", {})
    expect(found.data).toEqual({
      reminders: [{ ...REMINDER, id: undefined, reminder_ref: "REM-1" }],
      more: false
    })
    const refused = await run("mac_reminders_delete", { reminder_ref: "--undo" })
    expect(refused.content).toContain("reminder_ref")
    expect(await calls()).toEqual([["reminders", "list"]])
  })
})

describe("Mac app tools: faults and availability", () => {
  it("refuses with the helper's own words, in the tools' names, and does not ask to retry", async () => {
    await answer({
      "reminders list": {
        fault: {
          error: "denied",
          message:
            "Reminders access is off. The owner turns it on in System Settings > Privacy & Security > Reminders."
        }
      },
      "calendar get": {
        fault: {
          error: "not_found",
          message:
            "No event has this id. Search again with `arden-apple calendar events` and use the id it returns."
        }
      },
      "calendar create": { fault: { error: "usage", message: "--end must not be before --start." } }
    })
    await expect(run("mac_reminders_search", {})).rejects.toMatchObject({
      message:
        "Reminders access is off. The owner turns it on in System Settings > Privacy & Security > Reminders.",
      preview: "Access is off",
      retryable: false
    })
    await expect(run("mac_calendar_read_event", { event_ref: "gone" })).rejects.toMatchObject({
      message:
        "No event has this id. Search again with mac_calendar_search and use the id it returns.",
      preview: "Not found",
      retryable: false
    })
    await expect(
      run("mac_calendar_create_event", {
        title: "Lunch",
        start: "2026-11-18T12:00",
        end: "2026-11-18T11:00"
      })
    ).rejects.toMatchObject({ message: "end must not be before start.", retryable: false })
    await expect(card("mac_calendar_delete_event", { event_ref: "gone" })).rejects.toMatchObject({
      preview: "Not found"
    })
  })

  it("refuses off macOS, without the helper's path, and when the file is gone", async () => {
    const unavailable = { preview: "Mac apps are not available here", retryable: false }
    const read = (options: Parameters<typeof makeMacAppsTools>[0]) =>
      tool("mac_calendar_list_calendars", options).execute({}, context())
    await expect(read({ platform: "linux" })).rejects.toMatchObject(unavailable)
    await expect(read({ path: undefined })).rejects.toMatchObject(unavailable)
    await expect(read({ path: join(directory, "missing") })).rejects.toMatchObject(unavailable)
  })
})

describe("Mac app tools: approval cards", () => {
  it("shows what an event edit changes, and which occurrences", async () => {
    expect(
      await card("mac_calendar_edit_event", {
        event_ref: EVENT.id,
        title: "Dentist, Dr. Lee",
        start: "2026-11-19T09:30",
        location: "",
        calendar_id: "CAL-2",
        scope: "future"
      })
    ).toEqual({
      title: "Change this event?",
      approve_label: "Save changes",
      fields: [
        { label: "Event", value: "Dentist" },
        { label: "Applies to", value: "This and later events" },
        { label: "Title", value: "Dentist, Dr. Lee", from: "Dentist" },
        { label: "Starts", value: "Nov 19, 2026, 9:30 AM", from: "Nov 18, 2026, 9:30 AM" },
        { label: "Ends", value: "Nov 19, 2026, 10:15 AM", from: "Nov 18, 2026, 10:15 AM" },
        { label: "Calendar", value: "Work (Exchange)", from: "Home" },
        { label: "Repeats", value: "Every week" },
        { label: "Where", value: "Remove place", from: "12 Main St" }
      ],
      body: { label: "Notes", text: "Bring the x-ray" }
    })
    await expect(card("mac_calendar_edit_event", { event_ref: EVENT.id })).rejects.toMatchObject({
      message: "Provide at least one event change."
    })
    await expect(
      card("mac_calendar_edit_event", { event_ref: EVENT.id, start: "2026-11-19" })
    ).rejects.toMatchObject({
      message: "This event has times. To make it all-day, pass both start and end as days."
    })
  })
})

describe("Mac app tools: review findings", () => {
  const SINGLE = { ...EVENT, id: "EV-9", repeats: undefined }
  const CHANGED_OCCURRENCE = { ...EVENT, repeats: undefined }
  const appliesTo = (presentation: Awaited<ReturnType<typeof card>>) =>
    presentation?.fields.find((field) => field.label === "Applies to")?.value

  it("passes a span only for an event in a series, and then the card says which events", async () => {
    await answer({ "calendar get": { prints: SINGLE } })
    expect(
      appliesTo(await card("mac_calendar_delete_event", { event_ref: "EV-9", scope: "future" }))
    ).toBe(undefined)
    await run("mac_calendar_delete_event", { event_ref: "EV-9", scope: "future" })
    await run("mac_calendar_edit_event", { event_ref: "EV-9", title: "Checkup", scope: "future" })
    await answer({ "calendar get": { prints: CHANGED_OCCURRENCE } })
    expect(
      appliesTo(await card("mac_calendar_delete_event", { event_ref: EVENT.id, scope: "future" }))
    ).toBe("This and later events")
    await run("mac_calendar_delete_event", { event_ref: EVENT.id, scope: "future" })
    expect((await calls()).filter((call) => call[1] === "delete" || call[1] === "update")).toEqual([
      ["calendar", "delete", "EV-9"],
      ["calendar", "update", "EV-9", "--title", "Checkup"],
      ["calendar", "delete", EVENT.id, "--span", "future"]
    ])
  })

  it("refuses all_day with a time, and a contact query that reads as an option, before the helper runs", async () => {
    const timed = { title: "Trip", start: "2026-12-02T23:00:00-08:00", all_day: true }
    const refusal = { message: "With all_day, give start and end as days, such as 2026-11-18." }
    await expect(card("mac_calendar_create_event", timed)).rejects.toMatchObject(refusal)
    await expect(run("mac_calendar_create_event", timed)).rejects.toMatchObject(refusal)
    const dashed = await run("mac_contacts_search", { query: "--limit" })
    expect(dashed.content).toContain("query")
    await expect(calls()).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses a change to an item in a read-only calendar or list before any card", async () => {
    await answer({
      "calendar get": { prints: { ...EVENT, calendar: "Holidays", calendar_id: "CAL-3" } },
      "reminders lists": { prints: [{ ...LISTS[0], writable: false }] }
    })
    const calendar = {
      message: 'The calendar "Holidays" is read-only, so nothing in it can be changed from here.'
    }
    const list = {
      message: 'The list "Errands" is read-only, so nothing in it can be changed from here.'
    }
    await expect(
      card("mac_calendar_edit_event", { event_ref: EVENT.id, title: "X" })
    ).rejects.toMatchObject(calendar)
    await expect(card("mac_calendar_delete_event", { event_ref: EVENT.id })).rejects.toMatchObject(
      calendar
    )
    await expect(
      card("mac_reminders_edit", { reminder_ref: "REM-1", title: "X" })
    ).rejects.toMatchObject(list)
    await expect(card("mac_reminders_complete", { reminder_ref: "REM-1" })).rejects.toMatchObject(
      list
    )
    await expect(card("mac_reminders_delete", { reminder_ref: "REM-1" })).rejects.toMatchObject(
      list
    )
    await expect(
      card("mac_calendar_create_event", {
        title: "Trip",
        start: "2026-12-02",
        calendar_id: "CAL-3"
      })
    ).rejects.toMatchObject({
      message:
        'The calendar "Holidays" is read-only. Pick another one from mac_calendar_list_calendars.'
    })
  })

  it("adds a new item to the calendar or list its card named", async () => {
    const approved = (data: Record<string, string>) => ({
      ...context(),
      approval: { approved: true, feedback: null, data }
    })
    await tool("mac_calendar_create_event").execute(
      { title: "Lunch", start: "2026-11-18T12:00" },
      approved({ mac_target: "CAL-2" })
    )
    await tool("mac_reminders_create").execute(
      { title: "Call Sam" },
      approved({ mac_target: "LIST-9" })
    )
    expect(await calls()).toEqual([
      [
        "calendar",
        "create",
        "--title",
        "Lunch",
        "--start",
        "2026-11-18T12:00",
        "--calendar",
        "CAL-2"
      ],
      ["reminders", "create", "--title", "Call Sam", "--list", "LIST-9"]
    ])
  })

  it("moves an all-day event by its start and keeps its length", async () => {
    await answer({
      "calendar get": {
        prints: { ...SINGLE, all_day: true, start: "2026-12-02", end: "2026-12-05" }
      }
    })
    const moved = await card("mac_calendar_edit_event", { event_ref: "EV-9", start: "2026-12-10" })
    expect(moved?.fields.find((field) => field.label === "When")).toEqual({
      label: "When",
      value: "2026-12-10 to 2026-12-13 (all day, both days included)",
      from: "2026-12-02 to 2026-12-05 (all day, both days included)"
    })
  })

  const outcomeOf = async (attempt: Promise<unknown>) => {
    const cause = await attempt.then(
      () => undefined,
      (error: unknown) => error
    )
    if (!(cause instanceof ToolExecutionError)) throw new Error("expected a refusal", { cause })
    return {
      message: cause.message,
      retryable: cause.retryable,
      outcome: readMutationReceipt(cause.host)?.outcome
    }
  }
  const remove = (options: Parameters<typeof makeMacAppsTools>[0] = {}, signal?: AbortSignal) =>
    tool("mac_reminders_delete", options).execute(
      { reminder_ref: "REM-1" },
      {
        ...context(),
        ...(signal === undefined ? {} : { signal }),
        approval: { approved: true, feedback: null }
      }
    )

  it("says a change is unconfirmed when the helper hangs or prints nonsense, and failed when it faults", async () => {
    await answer({ "reminders delete": { hangs: true } })
    expect(await outcomeOf(remove({ timeoutMs: 300 }))).toEqual({
      message:
        "The Mac did not answer in 0 seconds; macOS may be waiting for the owner to allow access. The change may or may not have been made: read the item before you try again.",
      retryable: false,
      outcome: "unconfirmed"
    })
    await answer({ "reminders delete": { raw: "Deleted!" } })
    expect(await outcomeOf(remove())).toEqual({
      message:
        "The Mac's answer could not be read. The change may or may not have been made: read the item before you try again.",
      retryable: false,
      outcome: "unconfirmed"
    })
    await answer({ "reminders delete": { fault: { error: "read_only", message: "Read-only." } } })
    expect(await outcomeOf(remove())).toEqual({
      message: "Read-only.",
      retryable: false,
      outcome: "failed"
    })
  })

  it("stops with the run when a change is cancelled, and never reports it as a refusal", async () => {
    await answer({ "reminders delete": { hangs: true } })
    const controller = new AbortController()
    const attempt = remove({}, controller.signal)
    setTimeout(() => controller.abort(), 400)
    await expect(attempt).rejects.toMatchObject({ name: "AbortError" })
  })
})
