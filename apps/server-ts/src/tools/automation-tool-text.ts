import { countOf } from "@arden-hq/std/count"
import {
  AUTOMATION_ACTIVITY_TRIGGERS,
  AUTOMATION_CHAT_CHOICE,
  AUTOMATION_EVENTS,
  AUTOMATION_HISTORY,
  automationEnabledWord,
  DEFAULT_EVENT_LEAD_MINUTES,
  DROPPED_TRIGGER_FIELD,
  eventLeadWords,
  APP_EVENT,
  LEAD_EVENT,
  mergeTriggerInputs,
  runStatusOf,
  TRIGGER_INPUT,
  TRIGGER_MERGE,
  TRIGGER_STATE,
  TRIGGER_TYPE,
  type Automation,
  type AutomationEventLink,
  type AutomationRun,
  type AutomationOldCondition,
  type AutomationTrigger,
  type AutomationTriggerEdit,
  type AutomationTriggerInput,
  type AutomationTriggerSpec,
  type AutomationWaitingOn,
  type IntervalWindow,
  type McpEventSelector,
  type TimeTriggerSchedule
} from "@arden-hq/protocol/automations"
import {
  AutomationActivitySchema,
  AutomationSchema,
  SystemAutomationChatSchema,
  AutomationEventLinkSchema,
  AutomationRunChatSchema,
  AutomationRunOutputSchema,
  AutomationRunSchema,
  AutomationSkipRunWithEventSchema
} from "@arden-hq/protocol/effect/automations"
import { clipLine, cutText } from "@arden-hq/std/text"
import { oldConditions } from "../persistence/automations/event-words.js"
import { lastRunAt, nextRunAt } from "./automation-tool-data.js"
import type { CardTrigger } from "./automation-tool-triggers.js"

const WORDS_AUDIENCE = { agent: "agent", card: "card" } as const

type WordsAudience = (typeof WORDS_AUDIENCE)[keyof typeof WORDS_AUDIENCE]

const MODEL_SOURCE = {
  override: "override",
  chat: "chat",
  source_chat: "source_chat",
  background: "background",
  unknown: "unknown"
} as const

type ModelSource = (typeof MODEL_SOURCE)[keyof typeof MODEL_SOURCE]

type TriggerWordsOf = AutomationTriggerSpec | AutomationTriggerEdit

type TriggerView =
  | { readonly kind: "new"; readonly trigger: TriggerWordsOf }
  | { readonly kind: "edit"; readonly id: string; readonly trigger: TriggerWordsOf }

const asInput = (trigger: AutomationTrigger): TriggerView => ({
  kind: "edit",
  id: trigger.id,
  trigger
})

const triggerWords = (
  input: TriggerView,
  oldWords: ReadonlyMap<string, AutomationOldCondition>,
  audience: WordsAudience
): string => {
  const id =
    audience === WORDS_AUDIENCE.agent && input.kind === TRIGGER_INPUT.edit ? `${input.id}: ` : ""
  const old = input.kind === TRIGGER_INPUT.edit ? oldWords.get(input.id) : undefined
  return `${id}${triggerHead(input.trigger, audience)}${eventFields(input.trigger, old, audience)}`
}

const windowWords = (window: IntervalWindow): string =>
  window.kind === TRIGGER_STATE.between ? ` between ${window.start}-${window.end}` : ""

const scheduleWords = (schedule: TimeTriggerSchedule): string => {
  switch (schedule.kind) {
    case TRIGGER_STATE.next:
      return `at ${schedule.at}`
    case TRIGGER_STATE.once:
      return `at ${schedule.at} on ${schedule.on}`
    case TRIGGER_STATE.daily:
      return `at ${schedule.at} on ${schedule.days}`
    case TRIGGER_STATE.interval: {
      const days = schedule.days.kind === TRIGGER_STATE.days ? ` on ${schedule.days.days}` : ""
      return `every ${schedule.every}${days}${windowWords(schedule.window)}`
    }
  }
}

const appWords = (app: McpEventSelector, audience: WordsAudience): string => {
  const filters = Object.keys(app.arguments).length === 0 ? "" : ` ${JSON.stringify(app.arguments)}`
  return audience === WORDS_AUDIENCE.agent
    ? `mcp.event (${app.server}/${app.event}${filters})`
    : `${app.server}: ${app.event}`
}

const eventHead = (
  trigger: Extract<TriggerWordsOf, { readonly type: "event" }>,
  audience: WordsAudience
): string => {
  if (trigger.event_type === APP_EVENT && "server" in trigger.mcp_event)
    return appWords(trigger.mcp_event, audience)
  const lead =
    trigger.event_type === LEAD_EVENT
      ? eventLeadWords(
          trigger.lead.kind === TRIGGER_STATE.minutes
            ? trigger.lead.minutes
            : DEFAULT_EVENT_LEAD_MINUTES
        )
      : AUTOMATION_EVENTS[trigger.event_type].name
  return audience === WORDS_AUDIENCE.agent ? `${trigger.event_type} (${lead})` : lead
}

const triggerHead = (trigger: TriggerWordsOf, audience: WordsAudience): string => {
  switch (trigger.type) {
    case TRIGGER_TYPE.time:
      return scheduleWords(trigger.schedule)
    case TRIGGER_TYPE.idle:
      return AUTOMATION_ACTIVITY_TRIGGERS.idle.summary(trigger.idle_minutes)
    case TRIGGER_TYPE.count:
      return AUTOMATION_ACTIVITY_TRIGGERS.count.summary(trigger.every_n)
    case TRIGGER_TYPE.event:
      return eventHead(trigger, audience)
  }
}

const eventFields = (
  trigger: TriggerWordsOf,
  old: AutomationOldCondition | undefined,
  audience: WordsAudience
): string => {
  if (trigger.type !== TRIGGER_TYPE.event) return ""
  const sentence =
    trigger.run_only_if.kind === TRIGGER_STATE.sentence
      ? `, run only if: "${trigger.run_only_if.sentence}"`
      : ""
  const condition =
    old === undefined
      ? ""
      : `, old condition: ${old.words}${
          audience === WORDS_AUDIENCE.agent && !old.readable
            ? " (some of its fields have no words)"
            : ""
        }`
  return `${sentence}${condition}`
}

const byTrigger = (
  conditions: ReadonlyArray<AutomationOldCondition>
): ReadonlyMap<string, AutomationOldCondition> =>
  new Map(conditions.map((condition) => [condition.trigger_id, condition]))

export const triggersLabel = (
  automation: Pick<Automation, "triggers" | "old_conditions">,
  indent: string
): string =>
  automation.triggers
    .map(
      (trigger) =>
        `${indent}${triggerWords(asInput(trigger), byTrigger(automation.old_conditions), "agent")}`
    )
    .join("\n")

const defaultTriggersLabel = (
  triggers: ReadonlyArray<AutomationTriggerSpec>,
  indent: string
): string =>
  triggers
    .map((trigger) => `${indent}${triggerWords({ kind: "new", trigger }, new Map(), "agent")}`)
    .join("\n")

export const droppedTriggerLines = (
  current: Pick<Automation, "triggers" | "old_conditions">,
  sent: ReadonlyArray<AutomationTriggerInput>,
  indent: string
): ReadonlyArray<string> => {
  const merged = mergeTriggerInputs({ triggers: current.triggers, lastId: 0 }, sent)
  if (merged.kind !== TRIGGER_MERGE.ok) return []
  const old = byTrigger(current.old_conditions)
  return merged.dropped.map((dropped) => {
    switch (dropped.field) {
      case DROPPED_TRIGGER_FIELD.run_only_if:
        return `${indent}${dropped.id}: run only if "${dropped.value}"`
      case DROPPED_TRIGGER_FIELD.condition:
        return `${indent}${dropped.id}: old condition ${old.get(dropped.id)?.words ?? "(no words)"}`
    }
  })
}

export const storedTriggerWords = (triggers: ReadonlyArray<AutomationTrigger>): string => {
  const old = byTrigger(oldConditions(triggers))
  return triggers.map((trigger) => triggerWords(asInput(trigger), old, "card")).join(" or ")
}

const shownView = (view: TriggerView, appless: boolean): TriggerView =>
  appless && view.trigger.type === TRIGGER_TYPE.event && view.trigger.event_type === APP_EVENT
    ? { ...view, trigger: { ...view.trigger, mcp_event: { kind: TRIGGER_STATE.kept } } }
    : view

export const cardTriggerWords = (
  current: ReadonlyArray<AutomationTrigger>,
  cards: ReadonlyArray<CardTrigger>
): string => {
  const merged = mergeTriggerInputs(
    { triggers: current, lastId: 0 },
    cards.map((card) => card.input)
  )
  if (merged.kind !== TRIGGER_MERGE.ok)
    return cards
      .map((card) => triggerWords(shownView(card.input, card.appless), new Map(), "card"))
      .join(" or ")
  const old = byTrigger(oldConditions(merged.triggers))
  return merged.triggers
    .map((trigger, index) =>
      triggerWords(shownView(asInput(trigger), cards[index]?.appless === true), old, "card")
    )
    .join(" or ")
}

export const historyLabel = (automation: Automation): string => {
  if (AutomationSchema.guards.system(automation)) return "set by the system"
  switch (automation.history) {
    case AUTOMATION_HISTORY.fresh:
      return "starts fresh"
    case AUTOMATION_HISTORY.chat:
      return "reads the chat"
  }
}

export const chatLabel = (
  automation: Automation,
  info: AutomationModelInfo,
  currentSessionId: string
): string => {
  if (SystemAutomationChatSchema.guards.none(automation.chat)) return "none"
  if (automation.chat.kind === AUTOMATION_CHAT_CHOICE.own) return "its own chat"
  if (automation.chat.session_id === currentSessionId) return "this chat"
  return info.chat_ref ?? "one of your chats"
}

export const modelLabel = (info: AutomationModelInfo): string =>
  info.model_source === MODEL_SOURCE.source_chat
    ? "each chat's own model"
    : `${info.effective_model ?? "unknown"} (${info.model_source})`

export const SYSTEM_ACCEPTS =
  "A system Automation accepts only triggers, model, prompt, enabled and plan limits; a fork (Chat summaries) runs on each chat's model, so it has no model to change, and a job that runs no model has no prompt."

export const systemLines = (automation: Automation): ReadonlyArray<string> => {
  if (AutomationSchema.guards.user(automation)) return []
  const system = automation.settings
  return [
    `  Accepts: ${system.settable.join(", ")}, plan limits${automation.manual_run ? "" : " · no manual run"}`,
    `  Changed from default: ${system.changed.length === 0 ? "nothing" : system.changed.join(", ")}`,
    ...(system.changed.includes("triggers")
      ? ["  Default triggers:", defaultTriggersLabel(system.default_triggers, "    ")]
      : [])
  ]
}

export type AutomationModelInfo = {
  readonly model_source: ModelSource
  readonly effective_model: string | null
  readonly chat_ref: string | null
  readonly action_mode: string | null
}

export const scheduleStatus = (automation: Automation): string =>
  automationEnabledWord(automation.enabled)

const currentRunStatus = (automation: Automation): string =>
  AutomationActivitySchema.match(automation.activity, {
    waiting: ({ on }) => WAITING_STATUS[on],
    running: () => " · current run active",
    idle: () => ""
  })

const WAITING_STATUS: Record<AutomationWaitingOn, string> = {
  approval: " · paused for an approval",
  connection: " · paused for a reconnect"
}

export const formatAutomation = (
  automation: Automation,
  modelInfo: AutomationModelInfo,
  currentSessionId: string
): string => {
  const ref = automation.automation_ref
  const builtin = automation.builtin ? " [system]" : ""
  return [
    `[${ref}] ${automation.name}${builtin}`,
    `  Schedule: ${scheduleStatus(automation)}${currentRunStatus(automation)}`,
    ...(automation.waiting_events > 0
      ? [`  Waiting: ${countOf(automation.waiting_events, "event")}`]
      : []),
    "  Triggers:",
    triggersLabel(automation, "    "),
    ...(AutomationSchema.guards.user(automation)
      ? [
          `  Chat: ${chatLabel(automation, modelInfo, currentSessionId)}`,
          `  History: ${historyLabel(automation)}`
        ]
      : []),
    `  Model: ${modelLabel(modelInfo)}`,
    `  Action mode: ${modelInfo.action_mode ?? "inherited"}`,
    ...systemLines(automation),
    `  next: ${nextRunAt(automation) ?? "none"} · last: ${lastRunAt(automation) ?? "never"}`
  ].join("\n")
}

const skippedEventCall = (link: AutomationEventLink): string | undefined =>
  AutomationEventLinkSchema.match(link, {
    none: () => undefined,
    chat: ({ session_ref }) => `session_read(session_ref=${JSON.stringify(session_ref)})`,
    memory_page: ({ path }) => `wiki_read_page(path=${JSON.stringify(path)})`,
    task: ({ item_id }) => `task_get(item_id=${JSON.stringify(item_id)})`,
    connection_item: ({ item_id }) => `connection_item_read(item_id=${JSON.stringify(item_id)})`,
    connection_item_with_page: ({ item_id }) =>
      `connection_item_read(item_id=${JSON.stringify(item_id)})`
  })

const chatRunWords = AutomationRunChatSchema.match({
  none: () => "",
  chat: () => "",
  chat_run: ({ run_id }) => `, run_id ${run_id}`
})

const outputSummary = AutomationRunOutputSchema.match({
  none: () => undefined,
  result: ({ result }) => result,
  error: ({ error }) => error,
  result_and_error: ({ error }) => error
})

const ranByUserWords = AutomationSkipRunWithEventSchema.match({
  not_asked: () => "",
  queued: () => ", since run by the user",
  started: () => ", since run by the user",
  cancelled: () => ""
})

const runHead = (
  run: AutomationRun,
  status: string,
  chatRun: string,
  said: string | undefined
): string => {
  const summary = said?.replace(/\s+/gu, " ").trim()
  return [
    `- ${run.started_at}: ${status}, ${run.context_mode} context`,
    chatRun,
    summary === undefined || summary === "" ? "" : `. ${cutText(summary, 300)}`
  ].join("")
}

export const automationRunLines = (run: AutomationRun): string => {
  if (!AutomationRunSchema.isAnyOf(["skipped"])(run)) {
    return runHead(run, run.status, chatRunWords(run.chat), outputSummary(run.output))
  }
  const { event } = run.skip
  const open = skippedEventCall(event.link)
  return [
    runHead(run, runStatusOf("skipped:prefilter"), "", run.result),
    `  Held back: ${AUTOMATION_EVENTS[event.event_type].name} ${JSON.stringify(clipLine(event.title, 200))} (untrusted data)${ranByUserWords(run.skip.run_with_event)}.`,
    ...(open === undefined ? [] : [`  Open it with ${open}.`])
  ].join("\n")
}
