import type {
  AutomationTrigger,
  AutomationTriggerInput,
  EventAutomationTrigger,
  EventAutomationTriggerInput
} from "./contracts.js"

/** A trigger list and the highest id its Automation ever gave a trigger. The
 *  counter never goes down, so a deleted trigger's id is never given again. */
export interface StoredTriggers<Trigger = AutomationTrigger> {
  readonly triggers: ReadonlyArray<Trigger>
  readonly lastId: number
}

/** The event trigger fields a write reports when it lets one go: what was
 *  written to filter its events. */
type DroppableField = "condition" | "run_only_if"

/** A stored condition or sentence a write let go: its trigger left the list,
 *  moved to another event, or was sent with null for it. */
export type DroppedTriggerField = {
  readonly [Field in DroppableField]: {
    readonly id: string
    readonly field: Field
    readonly value: NonNullable<EventAutomationTrigger[Field]>
  }
}[DroppableField]

/** Sent triggers applied to the stored ones, or the id that cannot be applied. */
export type TriggerMerge =
  | ({
      readonly kind: "ok"
      readonly dropped: ReadonlyArray<DroppedTriggerField>
    } & StoredTriggers<AutomationTriggerInput>)
  /** An id this Automation never gave. */
  | { readonly kind: "unknown_id"; readonly id: string }
  /** An id it gave a trigger that has since been deleted: a stale editor's. */
  | { readonly kind: "deleted_id"; readonly id: string }
  | { readonly kind: "duplicate_id"; readonly id: string }

/** The event trigger fields one may leave out to keep: each is independent of the others. */
const KEPT_EVENT_FIELDS = ["lead_minutes", "mcp_event", "condition", "run_only_if"] as const

/**
 * The one way a trigger list is written over a stored one, for every caller
 * (the agent tools, the desktop, a system Automation's defaults). The sent list
 * replaces the stored list; a sent trigger with the `id` of a stored one edits
 * it, so an event trigger of the same event keeps each optional field it leaves
 * out (an old field condition it cannot see stays), and null clears that field.
 * A trigger sent without an id is new and gets the id after `lastId`, so no id
 * is given twice. Every trigger of the result carries its id, and no null;
 * `dropped` names each stored condition and sentence the write let go.
 */
export const mergeTriggerInputs = (
  stored: StoredTriggers,
  sent: ReadonlyArray<AutomationTriggerInput>
): TriggerMerge => {
  const byId = new Map(
    stored.triggers.flatMap((trigger) =>
      trigger.id === undefined ? [] : [[trigger.id, trigger] as const]
    )
  )
  let lastId = Math.max(
    stored.lastId,
    ...[...byId.keys()].map(idNumber).filter((id) => id !== undefined)
  )
  const seen = new Set<string>()
  const triggers: Array<AutomationTriggerInput> = []
  for (const trigger of sent) {
    if (trigger.id === undefined) {
      lastId += 1
      triggers.push(withoutNulls({ ...trigger, id: `t${lastId}` }))
      continue
    }
    if (seen.has(trigger.id)) return { kind: "duplicate_id", id: trigger.id }
    seen.add(trigger.id)
    const current = byId.get(trigger.id)
    if (current === undefined) {
      const given = idNumber(trigger.id)
      return given !== undefined && given <= lastId
        ? { kind: "deleted_id", id: trigger.id }
        : { kind: "unknown_id", id: trigger.id }
    }
    triggers.push(withoutNulls(kept(current, trigger)))
  }
  return { kind: "ok", triggers, lastId, dropped: droppedFields(stored.triggers, triggers) }
}

/** A trigger list with fresh ids in order (t1, t2, ...), for a list that replaces nothing. */
export const freshTriggerIds = (
  triggers: ReadonlyArray<AutomationTriggerInput>
): StoredTriggers<AutomationTriggerInput> => ({
  triggers: triggers.map((trigger, index) => withoutNulls({ ...trigger, id: `t${index + 1}` })),
  lastId: triggers.length
})

const idNumber = (id: string): number | undefined =>
  /^t[1-9][0-9]*$/.test(id) ? Number(id.slice(1)) : undefined

const droppedFields = (
  stored: ReadonlyArray<AutomationTrigger>,
  written: ReadonlyArray<AutomationTriggerInput>
): ReadonlyArray<DroppedTriggerField> => {
  const after = new Map(written.map((trigger) => [trigger.id, trigger] as const))
  return stored.flatMap((trigger): ReadonlyArray<DroppedTriggerField> => {
    if (trigger.type !== "event" || trigger.id === undefined) return []
    const id = trigger.id
    const next = after.get(id)
    const same = next?.type === "event" && sameEvent(trigger, next) ? next : undefined
    const dropped: Array<DroppedTriggerField> = []
    if (trigger.condition != null && same?.condition == null)
      dropped.push({ id, field: "condition", value: trigger.condition })
    if (trigger.run_only_if !== undefined && same?.run_only_if == null)
      dropped.push({ id, field: "run_only_if", value: trigger.run_only_if })
    return dropped
  })
}

const kept = (
  current: AutomationTrigger,
  trigger: AutomationTriggerInput
): AutomationTriggerInput => {
  if (current.type !== "event" || trigger.type !== "event" || !sameEvent(current, trigger))
    return trigger
  return KEPT_EVENT_FIELDS.reduce<EventAutomationTriggerInput>(
    (merged, field) =>
      Object.hasOwn(trigger, field) || current[field] === undefined
        ? merged
        : { ...merged, [field]: storedField(current, field) },
    trigger
  )
}

/**
 * Whether a sent event trigger still waits for the stored one's event: the
 * same type and, for an app event, the same app and event (a sent trigger that
 * leaves `mcp_event` out keeps the stored one). Other arguments are the same
 * event, narrowed differently.
 */
const sameEvent = (
  stored: EventAutomationTrigger,
  sent: EventAutomationTriggerInput | EventAutomationTrigger
): boolean => {
  if (stored.event_type !== sent.event_type) return false
  const before = stored.mcp_event
  const after = sent.mcp_event
  return (
    after === undefined ||
    after === null ||
    before === undefined ||
    (before.server === after.server && before.event === after.event)
  )
}

const storedField = (
  current: EventAutomationTrigger,
  field: (typeof KEPT_EVENT_FIELDS)[number]
): EventAutomationTriggerInput[typeof field] => current[field]

/** Null on a sent event field means "clear it": the stored trigger has no such field. */
const withoutNulls = (trigger: AutomationTriggerInput): AutomationTriggerInput => {
  if (trigger.type !== "event") return trigger
  const { lead_minutes, mcp_event, condition, run_only_if, ...rest } = trigger
  return {
    ...rest,
    ...(lead_minutes === undefined || lead_minutes === null ? {} : { lead_minutes }),
    ...(mcp_event === undefined || mcp_event === null ? {} : { mcp_event }),
    ...(condition === undefined || condition === null ? {} : { condition }),
    ...(run_only_if === undefined || run_only_if === null ? {} : { run_only_if })
  }
}
