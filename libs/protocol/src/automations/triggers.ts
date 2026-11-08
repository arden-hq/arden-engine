import { countOf } from "@arden-hq/std/count"
import type { AutomationConditionOperator, AutomationEventCatalogField } from "./contracts.js"

/**
 * The one trigger registry (rules §6.1): every trigger type and event type an
 * Automation can use, the fields an event's conditions read, and the words a
 * person and the agent see for each. The server validates against it, the
 * desktop labels its trigger editor from it, and the agent tools describe
 * triggers from it. A new event type is one entry here plus one server producer.
 */

export const TEXT_OPERATORS = [
  "eq",
  "ne",
  "contains",
  "starts_with",
  "ends_with",
  "in",
  "exists"
] as const satisfies ReadonlyArray<AutomationConditionOperator>

export const LIST_OPERATORS = [
  "eq",
  "ne",
  "contains",
  "in",
  "exists"
] as const satisfies ReadonlyArray<(typeof TEXT_OPERATORS)[number]>

export const NUMBER_OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "exists"
] as const satisfies ReadonlyArray<AutomationConditionOperator>

export const BOOLEAN_OPERATORS = [
  "eq",
  "ne",
  "in",
  "exists"
] as const satisfies ReadonlyArray<AutomationConditionOperator>

/** Every event an Automation can wait for, in the order the trigger editor offers them. */
export const AUTOMATION_EVENT_TYPES = [
  "event_approaching",
  "event_ended",
  "calendar.changed",
  "wiki.changed",
  "chat.quiet",
  "email.received",
  "github.received",
  "task.changed",
  "capture.arrived",
  "automation.run_ended",
  "automation.system_run_ended",
  "ask.waiting",
  "space.proposal_review_requested",
  "mcp.event"
] as const
export type AutomationEventType = (typeof AUTOMATION_EVENT_TYPES)[number]

export interface AutomationEventDefinition<T extends AutomationEventType = AutomationEventType> {
  readonly event_type: T
  /**
   * Who picks it. "user": the trigger editor's add menu offers it. "internal":
   * Arden's own machinery; an Automation may still wait for it, but the add
   * menu leaves it out.
   */
  readonly audience: "user" | "internal"
  /** What the trigger editor's add menu and the event catalog offer. */
  readonly label: string
  /** A trigger card's short name. */
  readonly name: string
  /** When it runs, in one sentence: the editor's lead line and the agent tool's description. */
  readonly sentence: string
  /** What one firing is, in "runs for every <each>". */
  readonly each: string
  readonly fields: ReadonlyArray<AutomationEventCatalogField>
}

const CALENDAR_INVITE_FIELDS = [
  {
    field: "event.organizer",
    label: "Organizer",
    hint: "The organizer's email address",
    type: "str",
    operators: TEXT_OPERATORS
  },
  {
    field: "event.my_response",
    label: "Your answer",
    hint: "needsAction, accepted, declined or tentative; empty when you were not invited",
    type: "str",
    operators: TEXT_OPERATORS
  }
] as const satisfies ReadonlyArray<AutomationEventCatalogField>

/** The local hour an all-day event's `event_approaching` trigger fires. */
export const ALL_DAY_EVENT_HOUR_WORDS = "08:00"

/** How far before a calendar event an `event_approaching` trigger without `lead_minutes` fires. */
export const DEFAULT_EVENT_LEAD_MINUTES = 60

export const AUTOMATION_EVENTS: {
  readonly [T in AutomationEventType]: AutomationEventDefinition<T>
} = {
  event_approaching: {
    event_type: "event_approaching",
    audience: "user",
    label: "Calendar event coming up",
    name: "Calendar event",
    sentence: `Runs a set number of minutes (lead_minutes, default ${DEFAULT_EVENT_LEAD_MINUTES}) before an event on a connected Google Calendar starts. An all-day event runs at ${ALL_DAY_EVENT_HOUR_WORDS} local time on its first day, whatever lead_minutes says. Covers the primary calendar and, when the user has allowed Arden to list calendars, every other selected calendar whose events they can read.`,
    each: "calendar event",
    fields: [
      { field: "event.summary", label: "Title", hint: "", type: "str", operators: TEXT_OPERATORS },
      {
        field: "event.minutes_until",
        label: "Minutes away",
        hint: "",
        type: "int",
        operators: NUMBER_OPERATORS
      },
      {
        field: "event.location",
        label: "Location",
        hint: "",
        type: "str",
        operators: TEXT_OPERATORS
      },
      {
        field: "event.attendees",
        label: "Attendees",
        hint: "",
        type: "list",
        operators: LIST_OPERATORS
      },
      ...CALENDAR_INVITE_FIELDS
    ]
  },
  event_ended: {
    event_type: "event_ended",
    audience: "user",
    label: "Calendar event ended",
    name: "Calendar event ended",
    sentence:
      "Runs once when a timed event on a connected Google Calendar ends, for follow-ups after a meeting. If Arden was not running, it still runs for an event that ended in the last 30 minutes. All-day events never end this way. Covers the same calendars as event_approaching.",
    each: "ended calendar event",
    fields: [
      { field: "event.summary", label: "Title", hint: "", type: "str", operators: TEXT_OPERATORS },
      {
        field: "event.minutes_since_end",
        label: "Minutes since it ended",
        hint: "",
        type: "int",
        operators: NUMBER_OPERATORS
      },
      {
        field: "event.location",
        label: "Location",
        hint: "",
        type: "str",
        operators: TEXT_OPERATORS
      },
      {
        field: "event.attendees",
        label: "Attendees",
        hint: "",
        type: "list",
        operators: LIST_OPERATORS
      },
      ...CALENDAR_INVITE_FIELDS
    ]
  },
  "calendar.changed": {
    event_type: "calendar.changed",
    audience: "user",
    label: "Calendar event added or changed",
    name: "Calendar change",
    sentence:
      "Runs when an event on a connected Google Calendar is created, changed or cancelled, about a minute later. event.change says which: created, changed or cancelled. Covers the primary calendar and, when the user has allowed Arden to list calendars, every other selected calendar whose events they can read.",
    each: "calendar change",
    fields: [
      {
        field: "event.change",
        label: "What happened",
        hint: "created, changed or cancelled",
        type: "str",
        operators: TEXT_OPERATORS
      },
      { field: "event.summary", label: "Title", hint: "", type: "str", operators: TEXT_OPERATORS },
      {
        field: "event.location",
        label: "Location",
        hint: "",
        type: "str",
        operators: TEXT_OPERATORS
      },
      {
        field: "event.attendees",
        label: "Attendees",
        hint: "",
        type: "list",
        operators: LIST_OPERATORS
      },
      ...CALENDAR_INVITE_FIELDS
    ]
  },
  "wiki.changed": {
    event_type: "wiki.changed",
    audience: "user",
    label: "Memory changed",
    name: "Memory changed",
    sentence: "Runs each time Arden saves a change to Memory.",
    each: "Memory change",
    fields: [
      {
        field: "change.paths",
        label: "Pages changed",
        hint: "For example areas/health.md",
        type: "list",
        operators: LIST_OPERATORS
      },
      {
        field: "change.page_count",
        label: "Number of pages",
        hint: "",
        type: "int",
        operators: NUMBER_OPERATORS
      },
      {
        field: "change.source",
        label: "Made by",
        hint: "user, agent, automation, or system",
        type: "str",
        operators: TEXT_OPERATORS
      },
      {
        field: "change.has_space_page",
        label: "Touches a Space page",
        hint: "",
        type: "bool",
        operators: BOOLEAN_OPERATORS
      }
    ]
  },
  "chat.quiet": {
    event_type: "chat.quiet",
    audience: "user",
    label: "A chat goes quiet",
    name: "Chat went quiet",
    sentence:
      "Runs when one of your chats has had no new message for ten minutes. Chats that Automations work in never count.",
    each: "chat that goes quiet",
    fields: [
      {
        field: "chat.your_messages",
        label: "Your new messages",
        hint: "Since the chat last paused",
        type: "int",
        operators: NUMBER_OPERATORS
      },
      { field: "chat.space", label: "Space", hint: "", type: "str", operators: TEXT_OPERATORS },
      { field: "chat.name", label: "Chat name", hint: "", type: "str", operators: TEXT_OPERATORS }
    ]
  },
  "email.received": {
    event_type: "email.received",
    audience: "user",
    label: "New email",
    name: "New email",
    sentence:
      "Runs for each new email Arden fetches from a connected Gmail account, about five minutes after it arrives.",
    each: "new email",
    fields: [
      { field: "item.title", label: "Subject", hint: "", type: "str", operators: TEXT_OPERATORS },
      { field: "item.sender", label: "From", hint: "", type: "str", operators: TEXT_OPERATORS }
    ]
  },
  "github.received": {
    event_type: "github.received",
    audience: "user",
    label: "New GitHub notification",
    name: "GitHub notification",
    sentence:
      "Runs for each new GitHub notification (issue, pull request, review, mention) Arden fetches, about five minutes after it arrives.",
    each: "GitHub notification",
    fields: [
      { field: "item.title", label: "Title", hint: "", type: "str", operators: TEXT_OPERATORS },
      {
        field: "item.sender",
        label: "Repository",
        hint: "owner/name",
        type: "str",
        operators: TEXT_OPERATORS
      }
    ]
  },
  "task.changed": {
    event_type: "task.changed",
    audience: "user",
    label: "A Task changes",
    name: "Task changed",
    sentence:
      "Runs when a Task is created, changes, or is blocked. task.change says which: created, changed or blocked.",
    each: "Task change",
    fields: [
      {
        field: "task.change",
        label: "What happened",
        hint: "created, changed or blocked",
        type: "str",
        operators: TEXT_OPERATORS
      },
      { field: "task.text", label: "Task", hint: "", type: "str", operators: TEXT_OPERATORS },
      { field: "task.space", label: "Space", hint: "", type: "str", operators: TEXT_OPERATORS },
      { field: "task.status", label: "Status", hint: "", type: "str", operators: TEXT_OPERATORS }
    ]
  },
  "capture.arrived": {
    event_type: "capture.arrived",
    audience: "user",
    label: "Something is captured",
    name: "Capture",
    sentence:
      "Runs when the user hands Arden something: a screenshot with a note, a quick capture, or a capture from iPhone. capture.via says which: screenshot, quick or phone.",
    each: "capture",
    fields: [
      {
        field: "capture.via",
        label: "From",
        hint: "screenshot, quick or phone",
        type: "str",
        operators: TEXT_OPERATORS
      },
      { field: "capture.note", label: "Note", hint: "", type: "str", operators: TEXT_OPERATORS },
      { field: "capture.space", label: "Space", hint: "", type: "str", operators: TEXT_OPERATORS }
    ]
  },
  "automation.run_ended": {
    event_type: "automation.run_ended",
    audience: "user",
    label: "Another Automation finishes",
    name: "Automation finished",
    sentence:
      "Runs when a run of another of your Automations finishes, fails or stops to ask. Add it only when the user asks to chain Automations. A run this event started never starts another one this way.",
    each: "finished run",
    fields: [
      {
        field: "run.automation",
        label: "Automation",
        hint: "",
        type: "str",
        operators: TEXT_OPERATORS
      },
      {
        field: "run.outcome",
        label: "Outcome",
        hint: "finished, failed or needs_you",
        type: "str",
        operators: TEXT_OPERATORS
      }
    ]
  },
  "automation.system_run_ended": {
    event_type: "automation.system_run_ended",
    audience: "internal",
    label: "A built-in Automation finishes",
    name: "Built-in run finished",
    sentence:
      "Runs when a run of one of Arden's built-in Automations (such as Memory Capture) finishes, fails or stops to ask. Internal: use only when the user asks for it.",
    each: "built-in run",
    fields: [
      {
        field: "run.automation",
        label: "Automation",
        hint: "",
        type: "str",
        operators: TEXT_OPERATORS
      },
      {
        field: "run.outcome",
        label: "Outcome",
        hint: "finished, failed or needs_you",
        type: "str",
        operators: TEXT_OPERATORS
      }
    ]
  },
  "ask.waiting": {
    event_type: "ask.waiting",
    audience: "internal",
    label: "An ask stays open",
    name: "An ask stays open",
    sentence:
      "Runs when a question, an approval or an account to connect is still open a minute after Arden asked. Only the user can answer it. Internal: use only when the user asks for it.",
    each: "open ask",
    fields: [
      {
        field: "ask.kind",
        label: "Kind",
        hint: "question, approval or connection",
        type: "str",
        operators: TEXT_OPERATORS
      },
      // oxlint-disable-next-line arden/restricted-owner -- an ask trigger's field, not a permission decision
      { field: "ask.text", label: "Ask", hint: "", type: "str", operators: TEXT_OPERATORS },
      {
        field: "ask.automation",
        label: "Asked by",
        hint: "The Automation whose run asks; empty for a chat",
        type: "str",
        operators: TEXT_OPERATORS
      }
    ]
  },
  "mcp.event": {
    event_type: "mcp.event",
    audience: "user",
    label: "An app sends an event",
    name: "App event",
    sentence:
      "Runs for each event a connected MCP app publishes, such as a new issue or message, as soon as the app delivers it. Requires mcp_event: the app's server name, one event it lists, and that event's arguments. Only apps that list events offer it; the error for an unknown event lists the ones available.",
    each: "app event",
    fields: [
      { field: "app.server", label: "App", hint: "", type: "str", operators: TEXT_OPERATORS },
      { field: "app.event", label: "Event", hint: "", type: "str", operators: TEXT_OPERATORS }
    ]
  },
  "space.proposal_review_requested": {
    event_type: "space.proposal_review_requested",
    audience: "internal",
    label: "Task proposal recheck",
    name: "Task proposal recheck",
    sentence: "Runs when the person asks Arden to recheck one offered Task proposal.",
    each: "Task proposal recheck",
    fields: []
  }
}

export const isAutomationEventType = (value: string): value is AutomationEventType =>
  Object.hasOwn(AUTOMATION_EVENTS, value)

/**
 * The activity triggers. Both read only your chats: a chat an Automation owns
 * (its own chat, a system chat, a run's copy or child) never counts.
 */
export const AUTOMATION_ACTIVITY_TRIGGERS = {
  idle: {
    name: "After inactivity",
    /** The editor's words after the number. */
    unit: "minutes with no new message from you in any chat",
    sentence:
      "Runs once you have sent no new message in any of your chats for idle_minutes minutes.",
    summary: (minutes: number): string => `After ${countOf(minutes, "minute")} without a message`
  },
  count: {
    name: "Chat turns",
    label: "Every N chat turns",
    unit: "chat turns in one of your chats",
    sentence:
      "Runs after every_n chat turns in one of your chats. A chat turn is your message and Arden's finished reply; each chat keeps its own count.",
    summary: (turns: number): string => `Every ${countOf(turns, "chat turn")}`
  }
} as const

/** An event trigger's own fields, one sentence each: what the agent tools say they do. */
export const EVENT_TRIGGER_FIELDS = {
  lead_minutes:
    "Only for event_approaching: whole minutes before the event starts. null goes back to the default.",
  mcp_event:
    "Only for mcp.event, and required there: server (the MCP server's name), event (one event that server lists) and arguments (an object matching that event's input schema, often filters; {} for none).",
  run_only_if:
    "Run only if: one plain sentence (up to 300 characters) about this event's content, e.g. a recruiter replied about one of my applications. No field names or syntax. Set it when many of these events are irrelevant (every email, every calendar change). Without it every event runs; on a trigger sent with its id, leaving it out keeps its sentence and null removes it. A confident no skips the run, unsure runs; a skipped wake is expected and shows in the run history. For cost only; never for safety or permissions."
} as const

/** When an `event_approaching` trigger fires, in words: "2 hours before each calendar event". */
export const eventLeadWords = (minutes: number): string => {
  if (minutes === 0) return "When each calendar event starts"
  const amount = minutes % 60 === 0 ? countOf(minutes / 60, "hour") : countOf(minutes, "minute")
  return `${amount} before each calendar event`
}
