import {
  freshTriggerIds,
  mergeTriggerInputs,
  type AutomationTrigger,
  type AutomationTriggerInput,
  type StoredTriggers,
  type TriggerMerge
} from "@arden-hq/protocol/automations"
import { AutomationTriggerSchema } from "@arden-hq/protocol/effect/automations"
import { Effect, Schema } from "effect"
import {
  InvalidAutomationScheduleError,
  type AutomationRules,
  type PersonalAutomationTriggers
} from "../automations/model.js"
import { AutomationStoreError } from "../automations/store.js"
import { decodeJson } from "./json.js"

export const AutomationTriggersSchema = Schema.Array(AutomationTriggerSchema)

export const listenerTriggers = (row: { readonly task_id: string; readonly triggers: string }) =>
  decodeJson(AutomationTriggersSchema, row.triggers).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Skipping Automation with corrupt stored triggers", {
        automationId: row.task_id,
        cause
      }).pipe(Effect.as(undefined))
    )
  )

export const scheduleEffect = (
  rules: AutomationRules["Service"],
  triggers: Parameters<AutomationRules["Service"]["triggers"]>[0],
  operation: AutomationStoreError["operation"],
  automationId?: string
): Effect.Effect<PersonalAutomationTriggers, AutomationStoreError> =>
  Effect.try({
    try: () => rules.triggers(triggers),
    catch: (cause) =>
      new AutomationStoreError({
        operation,
        reason: "invalid",
        message:
          cause instanceof InvalidAutomationScheduleError
            ? cause.message
            : "The Automation schedule is invalid",
        ...(automationId === undefined ? {} : { automationId }),
        cause
      })
  })

export const writtenTriggers = (
  stored: StoredTriggers | "new",
  sent: ReadonlyArray<AutomationTriggerInput>,
  operation: AutomationStoreError["operation"],
  automationId?: string
): Effect.Effect<StoredTriggers<AutomationTriggerInput>, AutomationStoreError> => {
  if (stored === "new") return Effect.succeed(freshTriggerIds(sent))
  const merged = mergeTriggerInputs(stored, sent)
  if (merged.kind === "ok") return Effect.succeed(merged)
  return Effect.fail(
    new AutomationStoreError({
      operation,
      reason: "invalid",
      message: MERGE_REFUSAL[merged.kind](merged.id),
      ...(automationId === undefined ? {} : { automationId })
    })
  )
}

const MERGE_REFUSAL: Readonly<Record<Exclude<TriggerMerge["kind"], "ok">, (id: string) => string>> =
  {
    unknown_id: (id) => `This Automation has no trigger ${id}; send a new trigger without an id`,
    deleted_id: (id) =>
      `Trigger ${id} was deleted since these triggers were read; read the Automation again and send its current triggers`,
    duplicate_id: (id) => `Trigger ${id} is sent twice`
  }

export const sameTriggers = (
  left: ReadonlyArray<AutomationTrigger>,
  right: ReadonlyArray<AutomationTrigger>
): boolean => JSON.stringify(left.map(withoutId)) === JSON.stringify(right.map(withoutId))

const withoutId = ({ id: _id, ...trigger }: AutomationTrigger) => trigger
