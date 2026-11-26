import type { AutomationCondition } from "./contracts.js"
import {
  APP_EVENT,
  LEAD_EVENT,
  TRIGGER_STATE,
  TRIGGER_TYPE,
  type AutomationTrigger,
  type AutomationTriggerInput,
  type AutomationTriggerSpec,
  type EventAutomationTrigger,
  type EventTriggerEdit,
  type KeptField,
  type McpEventSelector
} from "./trigger-contracts.js"

/** A trigger list and the highest id its Automation ever gave a trigger. The
 *  counter never goes down, so a deleted trigger's id is never given again. */
export interface StoredTriggers {
  readonly triggers: ReadonlyArray<AutomationTrigger>
  readonly lastId: number
}

/** A stored condition or sentence a write let go: its trigger left the list,
 *  moved to another event, or was sent with null for it. */
export type DroppedTriggerField =
  | { readonly id: string; readonly field: "condition"; readonly value: AutomationCondition }
  | { readonly id: string; readonly field: "run_only_if"; readonly value: string }

export const TRIGGER_MERGE = { ok: "ok" } as const

/** Sent triggers applied to the stored ones, or the id that cannot be applied. */
export type TriggerMerge =
  | ({
      readonly kind: "ok"
      readonly dropped: ReadonlyArray<DroppedTriggerField>
    } & StoredTriggers)
  /** An id this Automation never gave. */
  | { readonly kind: "unknown_id"; readonly id: string }
  /** An id it gave a trigger that has since been deleted: a stale editor's. */
  | { readonly kind: "deleted_id"; readonly id: string }
  | { readonly kind: "duplicate_id"; readonly id: string }
  /** An app event trigger that keeps an app event its stored trigger does not have. */
  | { readonly kind: "missing_app_event"; readonly id: string }

/**
 * The one way a trigger list is written over a stored one, for every caller
 * (the agent tools, the desktop, a system Automation's defaults). The sent list
 * replaces the stored list; an edit of a stored trigger's id keeps each event
 * field it marks kept from that trigger while it still waits for the same
 * event. A new trigger gets the id after `lastId`, so no id is given twice.
 * `dropped` names each stored condition and sentence the write let go.
 */
export const mergeTriggerInputs = (
  stored: StoredTriggers,
  sent: ReadonlyArray<AutomationTriggerInput>
): TriggerMerge => {
  const byId = new Map(stored.triggers.map((trigger) => [trigger.id, trigger] as const))
  let lastId = stored.lastId
  const seen = new Set<string>()
  const triggers: Array<AutomationTrigger> = []
  for (const input of sent) {
    switch (input.kind) {
      case "new": {
        do lastId += 1
        while (byId.has(triggerId(lastId)))
        triggers.push({ ...input.trigger, id: triggerId(lastId) })
        break
      }
      case "edit": {
        if (seen.has(input.id)) return { kind: "duplicate_id", id: input.id }
        seen.add(input.id)
        const current = byId.get(input.id)
        if (current === undefined) {
          return givenIds(lastId).has(input.id)
            ? { kind: "deleted_id", id: input.id }
            : { kind: "unknown_id", id: input.id }
        }
        const edited =
          input.trigger.type === TRIGGER_TYPE.event
            ? editedEvent(current, input.id, input.trigger)
            : { ...input.trigger, id: input.id }
        if (edited === undefined) return { kind: "missing_app_event", id: input.id }
        triggers.push(edited)
        break
      }
    }
  }
  return { kind: "ok", triggers, lastId, dropped: droppedFields(stored.triggers, triggers) }
}

/** A trigger list with fresh ids in order (t1, t2, ...), for a list that replaces nothing. */
export const freshTriggerIds = (
  triggers: ReadonlyArray<AutomationTriggerSpec>
): StoredTriggers => ({
  triggers: triggers.map((trigger, index) => ({ ...trigger, id: triggerId(index + 1) })),
  lastId: triggers.length
})

const triggerId = (counter: number): string => `t${counter}`

const givenIds = (lastId: number): ReadonlySet<string> =>
  new Set(Array.from({ length: lastId }, (_, index) => triggerId(index + 1)))

const isKept = <Field extends { readonly kind: string }>(
  field: Field | KeptField
): field is KeptField => field.kind === TRIGGER_STATE.kept

const sameApp = (left: McpEventSelector, right: McpEventSelector): boolean =>
  left.server === right.server && left.event === right.event

/**
 * The stored trigger an event edit keeps fields from: one of the same event
 * type and, for an app event, the same app and event (an edit that keeps
 * `mcp_event` keeps the stored one). Other arguments are the same event,
 * narrowed differently.
 */
const keptFrom = (
  current: AutomationTrigger,
  edit: EventTriggerEdit
): EventAutomationTrigger | undefined => {
  if (current.type !== TRIGGER_TYPE.event || current.event_type !== edit.event_type)
    return undefined
  if (edit.event_type !== APP_EVENT || current.event_type !== APP_EVENT) return current
  return isKept(edit.mcp_event) || sameApp(current.mcp_event, edit.mcp_event) ? current : undefined
}

const ANY_EVENT = { kind: "any_event" } as const
const NO_CONDITION = { kind: "none" } as const
const DEFAULT_LEAD = { kind: "default" } as const

const keptApp = (base: EventAutomationTrigger | undefined): McpEventSelector | undefined =>
  base?.event_type === APP_EVENT ? base.mcp_event : undefined

const chosenApp = (choice: McpEventSelector): McpEventSelector => ({
  server: choice.server,
  event: choice.event,
  arguments: choice.arguments
})

const editedEvent = (
  current: AutomationTrigger,
  id: string,
  edit: EventTriggerEdit
): EventAutomationTrigger | undefined => {
  const base = keptFrom(current, edit)
  const filters = {
    run_only_if: isKept(edit.run_only_if) ? (base?.run_only_if ?? ANY_EVENT) : edit.run_only_if,
    condition: isKept(edit.condition) ? (base?.condition ?? NO_CONDITION) : edit.condition
  }
  if (edit.event_type === LEAD_EVENT) {
    const storedLead = base?.event_type === LEAD_EVENT ? base.lead : DEFAULT_LEAD
    return {
      id,
      type: "event",
      event_type: edit.event_type,
      lead: isKept(edit.lead) ? storedLead : edit.lead,
      ...filters
    }
  }
  if (edit.event_type === APP_EVENT) {
    const selector = isKept(edit.mcp_event) ? keptApp(base) : chosenApp(edit.mcp_event)
    return selector === undefined
      ? undefined
      : { id, type: "event", event_type: edit.event_type, mcp_event: selector, ...filters }
  }
  return { id, type: "event", event_type: edit.event_type, ...filters }
}

const sameEvent = (stored: EventAutomationTrigger, written: AutomationTrigger): boolean =>
  written.type === TRIGGER_TYPE.event &&
  written.event_type === stored.event_type &&
  (stored.event_type !== APP_EVENT ||
    written.event_type !== APP_EVENT ||
    sameApp(stored.mcp_event, written.mcp_event))

const droppedFields = (
  stored: ReadonlyArray<AutomationTrigger>,
  written: ReadonlyArray<AutomationTrigger>
): ReadonlyArray<DroppedTriggerField> => {
  const after = new Map(written.map((trigger) => [trigger.id, trigger] as const))
  return stored.flatMap((trigger): ReadonlyArray<DroppedTriggerField> => {
    if (trigger.type !== TRIGGER_TYPE.event) return []
    const next = after.get(trigger.id)
    const same = next !== undefined && sameEvent(trigger, next) ? next : undefined
    const kept = same?.type === TRIGGER_TYPE.event ? same : undefined
    const dropped: Array<DroppedTriggerField> = []
    if (trigger.condition.kind === TRIGGER_STATE.old && kept?.condition.kind !== TRIGGER_STATE.old)
      dropped.push({ id: trigger.id, field: "condition", value: trigger.condition.condition })
    if (
      trigger.run_only_if.kind === TRIGGER_STATE.sentence &&
      kept?.run_only_if.kind !== TRIGGER_STATE.sentence
    )
      dropped.push({ id: trigger.id, field: "run_only_if", value: trigger.run_only_if.sentence })
    return dropped
  })
}
