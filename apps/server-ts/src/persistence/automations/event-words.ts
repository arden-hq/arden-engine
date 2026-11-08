import {
  AUTOMATION_EVENTS,
  type AutomationConditionInput,
  type AutomationConditionOperator,
  type AutomationEventType,
  type AutomationOldCondition,
  type AutomationSkippedEvent,
  type AutomationTrigger,
  type AutomationTriggerInput,
  type EventAutomationTrigger
} from "@arden-hq/protocol/automations"
import type { JsonValue } from "@arden-hq/protocol"
import { Predicate } from "effect"

export const runOnlyIfSentences = (
  matched: ReadonlyArray<EventAutomationTrigger>
): readonly [string, ...Array<string>] | undefined => {
  const sentences: Array<string> = []
  for (const trigger of matched) {
    if (trigger.run_only_if === undefined) return undefined
    if (!sentences.includes(trigger.run_only_if)) sentences.push(trigger.run_only_if)
  }
  const [first, ...rest] = sentences
  return first === undefined ? undefined : [first, ...rest]
}

const readField = (
  context: Readonly<Record<string, JsonValue>>,
  path: string
): JsonValue | undefined =>
  path
    .split(".")
    .reduce<JsonValue | undefined>(
      (value, part) =>
        Predicate.isObject(value) && !Array.isArray(value) && Object.hasOwn(value, part)
          ? value[part]
          : undefined,
      context
    )

export const skippedEventOf = (
  eventType: AutomationEventType,
  context: Readonly<Record<string, JsonValue>>
): AutomationSkippedEvent => {
  const text = (path: string): string | undefined => {
    const value = readField(context, path)
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
  }
  const fallback = AUTOMATION_EVENTS[eventType].name
  switch (eventType) {
    case "space.proposal_review_requested":
      return {
        event_type: eventType,
        title: text("proposal_id") ?? fallback,
        link: null
      }
    case "event_approaching":
    case "event_ended":
      return { event_type: eventType, title: text("event.summary") ?? fallback, link: null }
    case "wiki.changed": {
      const value = readField(context, "change.paths")
      const paths = Array.isArray(value)
        ? value.filter((path): path is string => typeof path === "string" && path !== "")
        : []
      const first = paths[0]
      if (first === undefined) return { event_type: eventType, title: fallback, link: null }
      return {
        event_type: eventType,
        title: paths.length === 1 ? first : `${first} and ${paths.length - 1} more`,
        link: { kind: "memory_page", path: first }
      }
    }
    case "chat.quiet": {
      const sessionId = text("chat.session_id")
      const sessionRef = text("chat.session_ref")
      return {
        event_type: eventType,
        title: text("chat.name") ?? "Untitled chat",
        link:
          sessionId === undefined || sessionRef === undefined
            ? null
            : { kind: "chat", session_id: sessionId, session_ref: sessionRef }
      }
    }
    case "email.received":
    case "github.received": {
      const itemId = text("item.item_id")
      return {
        event_type: eventType,
        title: text("item.title") ?? fallback,
        link:
          itemId === undefined
            ? null
            : { kind: "connection_item", item_id: itemId, url: text("item.url") ?? null }
      }
    }
    case "task.changed": {
      const itemId = text("task.item_id")
      return {
        event_type: eventType,
        title: text("task.text") ?? fallback,
        link: itemId === undefined ? null : { kind: "task", item_id: itemId }
      }
    }
    case "calendar.changed":
      return { event_type: eventType, title: text("event.summary") ?? fallback, link: null }
    case "mcp.event": {
      const server = text("app.server")
      const event = text("app.event")
      return {
        event_type: eventType,
        title: server === undefined || event === undefined ? fallback : `${server}: ${event}`,
        link: null
      }
    }
    case "ask.waiting":
    case "capture.arrived": {
      const prefix = eventType === "ask.waiting" ? "ask" : "capture"
      const sessionId = text(`${prefix}.session_id`)
      const sessionRef = text(`${prefix}.session_ref`)
      return {
        event_type: eventType,
        title: text(eventType === "ask.waiting" ? "ask.text" : "capture.note") ?? fallback,
        link:
          sessionId === undefined || sessionRef === undefined
            ? null
            : { kind: "chat", session_id: sessionId, session_ref: sessionRef }
      }
    }
    case "automation.run_ended":
    case "automation.system_run_ended": {
      const sessionId = text("run.session_id")
      const sessionRef = text("run.session_ref")
      return {
        event_type: eventType,
        title: text("run.automation") ?? fallback,
        link:
          sessionId === undefined || sessionRef === undefined
            ? null
            : { kind: "chat", session_id: sessionId, session_ref: sessionRef }
      }
    }
  }
}

interface FieldWords {
  readonly subject: string
  readonly value?: (value: string) => string
  readonly flag?: readonly [string, string]
}

const FIELD_WORDS: Readonly<Record<string, FieldWords>> = {
  "event.minutes_until": { subject: "the minutes until it starts" },
  "change.paths": { subject: "the changed pages" },
  "change.page_count": { subject: "the number of changed pages" },
  "change.source": {
    subject: "the change author",
    value: (value) => CHANGE_AUTHORS[value] ?? `"${value}"`
  },
  "change.has_space_page": {
    subject: "it touches a Space page",
    flag: ["it touches a Space page", "it does not touch a Space page"]
  },
  "item.title": { subject: "the title" },
  "item.sender": { subject: "the sender" },
  "github.received:item.sender": { subject: "the repository" },
  "task.change": { subject: "what happened to the Task" },
  "event.change": { subject: "what happened to the event" },
  "capture.via": { subject: "where the capture came from" },
  "ask.kind": { subject: "the kind of ask" },
  "ask.automation": { subject: "the Automation that asks" }
}

const CHANGE_AUTHORS: Readonly<Record<string, string>> = {
  user: "you",
  agent: "an agent",
  automation: "an Automation",
  system: "Arden"
}

const OPERATOR_WORDS: Record<Exclude<AutomationConditionOperator, "exists" | "in">, string> = {
  eq: "is",
  ne: "is not",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  contains: "contains",
  starts_with: "starts with",
  ends_with: "ends with"
}

interface Words {
  readonly text: string
  readonly readable: boolean
}

const fieldWords = (eventType: AutomationEventType, field: string): FieldWords | undefined => {
  const entry = AUTOMATION_EVENTS[eventType].fields.find((candidate) => candidate.field === field)
  if (entry === undefined) return undefined
  return (
    FIELD_WORDS[`${eventType}:${field}`] ??
    FIELD_WORDS[field] ?? { subject: `the ${entry.label.toLowerCase()}` }
  )
}

const valueWords = (value: JsonValue | undefined, field: FieldWords): Words => {
  if (typeof value === "string")
    return { text: field.value?.(value) ?? `"${value}"`, readable: true }
  if (typeof value === "number" || typeof value === "boolean")
    return { text: String(value), readable: true }
  if (Array.isArray(value)) {
    const parts = value.map((entry) => valueWords(entry, field))
    return {
      text: parts.map((part) => part.text).join(", "),
      readable: parts.every((part) => part.readable)
    }
  }
  if (value === null || value === undefined) return { text: "nothing", readable: false }
  return {
    text: Object.entries(value)
      .map(([name, entry]) => `${name} ${valueWords(entry, field).text}`)
      .join(", "),
    readable: false
  }
}

const compareWords = (
  eventType: AutomationEventType,
  condition: Extract<AutomationConditionInput, { kind: "compare" }>
): Words => {
  const known = fieldWords(eventType, condition.field)
  const field = known ?? { subject: `"${condition.field}"` }
  if (field.flag !== undefined && typeof condition.value === "boolean") {
    const holds = (condition.op === "eq") === condition.value
    if (condition.op === "eq" || condition.op === "ne")
      return { text: holds ? field.flag[0] : field.flag[1], readable: known !== undefined }
  }
  if (condition.op === "exists")
    return { text: `${field.subject} is set`, readable: known !== undefined }
  const value = valueWords(condition.value, field)
  const verb = condition.op === "in" ? "is one of" : OPERATOR_WORDS[condition.op]
  return {
    text: `${field.subject} ${verb} ${value.text}`,
    readable: known !== undefined && value.readable
  }
}

const clauseWords = (
  eventType: AutomationEventType,
  condition: AutomationConditionInput,
  nested: boolean
): Words => {
  switch (condition.kind) {
    case "compare":
      return compareWords(eventType, condition)
    case "not": {
      const inner = clauseWords(eventType, condition.condition, false)
      return { text: `not (${inner.text})`, readable: inner.readable }
    }
    case "and":
    case "or": {
      const parts = condition.conditions.map((child) => clauseWords(eventType, child, true))
      const joined = parts
        .map((part) => part.text)
        .join(condition.kind === "and" ? " and " : " or ")
      return {
        text: nested && condition.conditions.length > 1 ? `(${joined})` : joined,
        readable: parts.every((part) => part.readable)
      }
    }
  }
}

export const oldConditions = (
  triggers: ReadonlyArray<AutomationTrigger | AutomationTriggerInput>
): ReadonlyArray<AutomationOldCondition> =>
  triggers.flatMap((trigger) => {
    if (trigger.type !== "event" || trigger.id === undefined) return []
    if (trigger.condition === undefined || trigger.condition === null) return []
    const words = clauseWords(trigger.event_type, trigger.condition, false)
    return [
      {
        trigger_id: trigger.id,
        words: `${words.text.charAt(0).toUpperCase()}${words.text.slice(1)}`,
        readable: words.readable
      }
    ]
  })
