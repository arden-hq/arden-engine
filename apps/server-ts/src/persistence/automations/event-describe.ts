import { AUTOMATION_EVENT_TYPE, isAutomationEventType } from "@arden-hq/protocol/automations"

import { type BatchedEvent } from "./event-batch.js"
import { iso } from "../../runtime/clock.js"
import { readChangeArgs } from "../../lib/memory-link.js"
import { readField, readText, readNumber, readFlag, readTexts } from "./event-context.js"
import {
  type EventLines,
  type ToolCall,
  LISTED_VALUES,
  CHANGE_AUTHORS,
  call,
  jsonText,
  listed,
  payloadLines
} from "./event-text-basics.js"

export const describe = (event: BatchedEvent): EventLines => {
  const queuedAt = Date.parse(event.queued_at)
  if (!isAutomationEventType(event.event_type)) {
    return {
      what: `An event of type ${jsonText(event.event_type)} arrived`,
      at: queuedAt,
      source: "an event source this version of Arden does not know",
      excerpt: [],
      followUps: [],
      note: "No tool reads this event."
    }
  }
  const text = (path: string) => readText(event.context, path)
  switch (event.event_type) {
    case AUTOMATION_EVENT_TYPE.space_proposal_review_requested: {
      const proposalId = text("proposal_id") ?? "an offered proposal"
      const revision = readNumber(event.context, "expected_revision")
      return {
        what: "The person asked for an explicit Task proposal recheck",
        at: queuedAt,
        source: `proposal ${jsonText(proposalId)}${revision === undefined ? "" : ` at revision ${revision}`}.`,
        excerpt: [],
        followUps: [],
        note: "Review this proposal only. Revalidate its evidence and preserve the offer unless the evidence supports revision or retirement."
      }
    }
    case AUTOMATION_EVENT_TYPE.chat_quiet: {
      const ref = text("chat.session_ref")
      const through = readNumber(event.context, "chat.through_sequence")
      const from = readNumber(event.context, "chat.from_sequence")
      const yours = readNumber(event.context, "chat.your_messages")
      const space = text("chat.space")
      const lastAt = Date.parse(text("chat.last_message_at") ?? "")
      return {
        what: "A chat went quiet; its last message was",
        at: Number.isFinite(lastAt) ? lastAt : queuedAt,
        source: [
          `the chat ${jsonText(text("chat.name") ?? "Untitled chat")}`,
          ...(space === undefined ? [] : [` in Space ${jsonText(space)}`]),
          ...(from === undefined || through === undefined
            ? []
            : [`, messages ${from} to ${through}`]),
          ...(yours === undefined ? [] : [`, ${yours} of them from the user`]),
          "."
        ].join(""),
        excerpt: readTexts(event.context, "chat.excerpts"),
        followUps:
          ref === undefined
            ? []
            : [
                call(
                  "session_read",
                  `session_ref=${jsonText(ref)}${through === undefined ? "" : `, around_seq=${through}`}`
                )
              ],
        note: ref === undefined ? "The chat's session_ref was not recorded." : undefined
      }
    }
    case AUTOMATION_EVENT_TYPE.wiki_changed: {
      const paths = readTexts(event.context, "change.paths")
      const author = text("change.source")
      const [first] = paths
      const savedAt = text("change.saved_at")
      return {
        what: "Memory changed",
        at: queuedAt,
        source: [
          `${paths.length === 1 ? "the Memory page" : `${paths.length} Memory pages:`} ${listed(paths)}`,
          ...(author === undefined ? [] : [`, changed by ${CHANGE_AUTHORS[author] ?? author}`]),
          ...(readFlag(event.context, "change.has_space_page") ? [", including a Space page"] : []),
          "."
        ].join(""),
        excerpt: [],
        followUps:
          first === undefined
            ? []
            : [
                call("wiki_read_change", readChangeArgs(first, savedAt)),
                call("wiki_read_page", `path=${jsonText(first)}`)
              ],
        note:
          first === undefined
            ? undefined
            : "The first call shows what this change did; the second shows the page as it is now."
      }
    }
    case AUTOMATION_EVENT_TYPE.event_approaching:
    case AUTOMATION_EVENT_TYPE.event_ended: {
      const ended = event.event_type === AUTOMATION_EVENT_TYPE.event_ended
      const title = text("event.summary") ?? "Busy"
      const start = text("event.start")
      const at = Date.parse((ended ? text("event.end") : start) ?? "")
      const startAt = Date.parse(start ?? "")
      const account = text("event.account")
      const eventId = text("event.event_id")
      const calendarId = text("event.calendar_id")
      const location = text("event.location")
      const attendees = readTexts(event.context, "event.attendees")
      return {
        what: `The calendar event ${jsonText(title)} ${ended ? "ended" : "starts"}`,
        at: Number.isFinite(at) ? at : queuedAt,
        source: `Google Calendar${account === undefined ? "" : ` of ${account}`}.`,
        excerpt: [
          `Title: ${title}`,
          ...(readFlag(event.context, "event.all_day") ? ["An all-day event"] : []),
          ...(location === undefined ? [] : [`Location: ${location}`]),
          ...(attendees.length === 0
            ? []
            : [`Attendees: ${attendees.slice(0, LISTED_VALUES).join(", ")}`]),
          ...inviteLines(text("event.organizer"), text("event.my_response"))
        ],
        followUps: [calendarCall({ eventId, account, calendarId, title, start, startAt })].filter(
          (call) => call !== undefined
        ),
        note: undefined
      }
    }
    case AUTOMATION_EVENT_TYPE.automation_run_ended:
    case AUTOMATION_EVENT_TYPE.automation_system_run_ended: {
      const ref = text("run.session_ref")
      const report = text("run.report")
      const outcome = text("run.outcome")
      return {
        what: `The Automation ${jsonText(text("run.automation") ?? "Untitled")} ${RUN_OUTCOMES[outcome ?? ""] ?? "ended"}`,
        at: queuedAt,
        source: `the Automation with automation_ref ${jsonText(text("run.automation_ref") ?? "unknown")}.`,
        excerpt: report === undefined ? [] : [report],
        followUps: ref === undefined ? [] : [call("session_read", `session_ref=${jsonText(ref)}`)],
        note: "A run this event started never wakes another Automation when it ends."
      }
    }
    case AUTOMATION_EVENT_TYPE.email_received:
    case AUTOMATION_EVENT_TYPE.github_received: {
      const item = text("item.item_id")
      const sender = text("item.sender")
      const url = text("item.url")
      const received = Date.parse(text("item.received_at") ?? "")
      const email = event.event_type === AUTOMATION_EVENT_TYPE.email_received
      return {
        what: email ? "An email arrived" : "A GitHub notification arrived",
        at: Number.isFinite(received) ? received : queuedAt,
        source: [
          email ? "Gmail" : "GitHub",
          ...(sender === undefined ? [] : [`, from ${jsonText(sender)}`]),
          ...(url === undefined ? [] : [`, at ${url}`]),
          "."
        ].join(""),
        excerpt: [
          `${email ? "Subject" : "Title"}: ${text("item.title") ?? ""}`,
          ...(text("item.snippet") === undefined ? [] : [text("item.snippet") ?? ""])
        ],
        followUps:
          item === undefined ? [] : [call("connection_item_read", `item_id=${jsonText(item)}`)],
        note: undefined
      }
    }
    case AUTOMATION_EVENT_TYPE.calendar_changed: {
      const title = text("event.summary") ?? "an event"
      const change = text("event.change")
      const account = text("event.account")
      const eventId = text("event.event_id")
      const calendarId = text("event.calendar_id")
      const start = text("event.start")
      const location = text("event.location")
      const attendees = readTexts(event.context, "event.attendees")
      const updated = Date.parse(text("event.updated") ?? "")
      const cancelled = change === CALENDAR_CHANGES.cancelled
      return {
        what: `The calendar event ${jsonText(title)} was ${CALENDAR_CHANGES[change ?? ""] ?? "changed"}`,
        at: Number.isFinite(updated) ? updated : queuedAt,
        source: `Google Calendar${account === undefined ? "" : ` of ${account}`}.`,
        excerpt: [
          `Title: ${title}`,
          ...(start === undefined ? [] : [`Starts: ${start}`]),
          ...(readFlag(event.context, "event.recurring") ? ["A recurring series"] : []),
          ...(location === undefined ? [] : [`Location: ${location}`]),
          ...(attendees.length === 0
            ? []
            : [`Attendees: ${attendees.slice(0, LISTED_VALUES).join(", ")}`]),
          ...inviteLines(text("event.organizer"), text("event.my_response"))
        ],
        followUps: cancelled
          ? calendarSlotCall({ account, calendarId, start, end: text("event.end") })
          : calendarEventCall(eventId, account, calendarId),
        note: cancelled
          ? "It was cancelled, so no tool opens it now; its time slot shows what is there instead."
          : undefined
      }
    }
    case AUTOMATION_EVENT_TYPE.ask_waiting: {
      const ref = text("ask.session_ref")
      const chat = text("ask.chat")
      const space = text("ask.space")
      const automation = text("ask.automation")
      const detail = text("ask.detail")
      const askedAt = Date.parse(text("ask.asked_at") ?? "")
      return {
        what: `${ASK_KINDS[text("ask.kind") ?? ""] ?? "Arden asked the user something"}${text("ask.tool") === undefined ? "" : ` (${text("ask.tool")})`} and still waits; it asked`,
        at: Number.isFinite(askedAt) ? askedAt : queuedAt,
        source: [
          chat === undefined ? "a chat" : `the chat ${jsonText(chat)}`,
          ...(space === undefined ? [] : [` in Space ${jsonText(space)}`]),
          ...(automation === undefined
            ? []
            : [`, asked by the Automation ${jsonText(automation)}`]),
          "."
        ].join(""),
        excerpt: [text("ask.text") ?? "", ...(detail === undefined ? [] : [detail])],
        followUps: ref === undefined ? [] : [call("session_read", `session_ref=${jsonText(ref)}`)],
        note: "Only the user can answer it; an Automation cannot answer or approve it."
      }
    }
    case AUTOMATION_EVENT_TYPE.mcp_event: {
      const server = text("app.server") ?? "an app"
      const happenedAt = Date.parse(text("app.at") ?? "")
      const omitted = readNumber(event.context, "app.data_omitted_bytes")
      return {
        what: `The app ${jsonText(server)} sent the event ${jsonText(text("app.event") ?? "")}; it happened`,
        at: Number.isFinite(happenedAt) ? happenedAt : queuedAt,
        source: `the MCP server ${jsonText(server)}, event id ${jsonText(text("app.event_id") ?? "")}.`,
        excerpt: payloadLines(readField(event.context, "app.data")),
        followUps: [],
        note:
          omitted === undefined
            ? `Act on it with ${jsonText(server)}'s own tools.`
            : `Its payload (${omitted} bytes) was too large to keep; read it with ${jsonText(server)}'s own tools.`
      }
    }
    case AUTOMATION_EVENT_TYPE.capture_arrived: {
      const ref = text("capture.session_ref")
      const chat = text("capture.chat")
      const space = text("capture.space")
      const note = text("capture.note")
      return {
        what: CAPTURE_WAYS[text("capture.via") ?? ""] ?? "The user captured something",
        at: queuedAt,
        source: [
          chat === undefined ? "a new chat" : `the chat ${jsonText(chat)}`,
          ...(space === undefined ? [] : [` in Space ${jsonText(space)}`]),
          "."
        ].join(""),
        excerpt: note === undefined ? [] : [note],
        followUps: ref === undefined ? [] : [call("session_read", `session_ref=${jsonText(ref)}`)],
        note: readFlag(event.context, "capture.screenshot")
          ? "The screenshot is in that chat's message."
          : undefined
      }
    }
    case AUTOMATION_EVENT_TYPE.task_changed: {
      const spaceId = text("task.space_id")
      const key = text("task.key")
      const space = text("task.space")
      const summary = text("task.summary")
      const blocked = readFlag(event.context, "task.blocked")
      return {
        what: `A Task was ${TASK_CHANGES[text("task.change") ?? ""] ?? "changed"}`,
        at: queuedAt,
        source: [
          `the Task ${jsonText(text("task.text") ?? "")}`,
          ...(key === undefined
            ? []
            : [` (key ${key}, ${blocked ? "blocked" : (text("task.status") ?? "open")})`]),
          space === undefined ? ", not on a Space" : ` in Space ${jsonText(space)}`,
          "."
        ].join(""),
        excerpt: summary === undefined ? [] : [summary],
        followUps: [taskCall({ spaceId, key, itemId: text("task.item_id") })].filter(
          (call) => call !== undefined
        ),
        note: undefined
      }
    }
  }
}

const taskCall = (task: {
  readonly spaceId: string | undefined
  readonly key: string | undefined
  readonly itemId: string | undefined
}): ToolCall | undefined => {
  if (task.spaceId !== undefined && task.key !== undefined)
    return call("task_get", `space_id=${jsonText(task.spaceId)}, key=${jsonText(task.key)}`)
  return task.itemId === undefined
    ? undefined
    : call("task_get", `item_id=${jsonText(task.itemId)}`)
}

const calendarArg = (calendarId: string | undefined): string =>
  calendarId === undefined ? "" : `, calendar_id=${jsonText(calendarId)}`

const inviteLines = (
  organizer: string | undefined,
  response: string | undefined
): ReadonlyArray<string> => [
  ...(organizer === undefined ? [] : [`Organizer: ${organizer}`]),
  ...(response === undefined ? [] : [`Your answer: ${response}`])
]

const calendarCall = (event: {
  readonly eventId: string | undefined
  readonly account: string | undefined
  readonly calendarId: string | undefined
  readonly title: string
  readonly start: string | undefined
  readonly startAt: number
}): ToolCall | undefined => {
  if (event.eventId !== undefined && event.account !== undefined)
    return call(
      "calendar_read_event",
      `event_id=${jsonText(event.eventId)}, account=${jsonText(event.account)}${calendarArg(event.calendarId)}`
    )
  if (event.start === undefined || !Number.isFinite(event.startAt)) return undefined
  return call(
    "calendar_search",
    `query=${jsonText(event.title)}${event.account === undefined ? "" : `, account_ref=${jsonText(event.account)}`}${calendarArg(event.calendarId)}, time_min=${jsonText(event.start)}, time_max=${jsonText(iso(event.startAt + 60_000))}`
  )
}

const calendarEventCall = (
  eventId: string | undefined,
  account: string | undefined,
  calendarId: string | undefined
): ReadonlyArray<ToolCall> =>
  eventId === undefined || account === undefined
    ? []
    : [
        call(
          "calendar_read_event",
          `event_id=${jsonText(eventId)}, account=${jsonText(account)}${calendarArg(calendarId)}`
        )
      ]

const calendarSlotCall = (event: {
  readonly account: string | undefined
  readonly calendarId: string | undefined
  readonly start: string | undefined
  readonly end: string | undefined
}): ReadonlyArray<ToolCall> => {
  const startAt = Date.parse(event.start ?? "")
  if (!Number.isFinite(startAt)) return []
  const endAt = Date.parse(event.end ?? "")
  const bound = (ms: number) => jsonText(iso(ms))
  return [
    call(
      "calendar_search",
      `${event.account === undefined ? "" : `account_ref=${jsonText(event.account)}, `}${event.calendarId === undefined ? "" : `calendar_id=${jsonText(event.calendarId)}, `}time_min=${bound(startAt)}, time_max=${bound(endAt > startAt ? endAt : startAt + 60 * 60_000)}`
    )
  ]
}

const RUN_OUTCOMES: Readonly<Record<string, string>> = {
  finished: "finished",
  failed: "failed",
  needs_you: "stopped to ask the user"
}

const CALENDAR_CHANGES: Readonly<Record<string, string>> = {
  created: "created",
  changed: "changed",
  cancelled: "cancelled"
}

const ASK_KINDS: Readonly<Record<string, string>> = {
  question: "Arden asked the user a question",
  approval: "Arden asked the user to approve a step",
  connection: "Arden asked the user to connect an account"
}

const CAPTURE_WAYS: Readonly<Record<string, string>> = {
  screenshot: "The user handed Arden a screenshot",
  quick: "The user sent a quick capture",
  phone: "The user sent a capture from iPhone"
}

const TASK_CHANGES: Readonly<Record<string, string>> = {
  created: "created",
  changed: "changed",
  blocked: "blocked"
}

export const sourceListing = (eventType: string): ReadonlyArray<string> => {
  switch (eventType) {
    case AUTOMATION_EVENT_TYPE.chat_quiet:
      return ["recent chats with session_list()"]
    case AUTOMATION_EVENT_TYPE.wiki_changed:
      return ["Memory changes with wiki_list_changes(since=...), since set before that time"]
    case AUTOMATION_EVENT_TYPE.event_approaching:
    case AUTOMATION_EVENT_TYPE.event_ended:
    case AUTOMATION_EVENT_TYPE.calendar_changed:
      return ["calendar events with calendar_search(time_min=..., time_max=...)"]
    case AUTOMATION_EVENT_TYPE.capture_arrived:
      return ["recent chats with session_list()"]
    case AUTOMATION_EVENT_TYPE.email_received:
    case AUTOMATION_EVENT_TYPE.github_received:
      return ["mail and GitHub items with connection_items_state()"]
    default:
      return []
  }
}
