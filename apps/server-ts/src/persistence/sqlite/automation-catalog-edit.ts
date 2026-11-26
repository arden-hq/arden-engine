import {
  type Automation,
  type AutomationChange,
  type SystemAutomationSetting
} from "@arden-hq/protocol/automations"
import { Effect } from "effect"
import { AutomationCatalog } from "../automations/catalog.js"
import { AutomationStoreError } from "../automations/store.js"
import { JOB_PURPOSE } from "../job-classification.js"
import type { AutomationStoreDeps } from "./automation-rows.js"
import { storeError, automationIdEffect, systemSpecOf } from "./automation-rows.js"
import { defaultTriggerInputs, systemSettable } from "../automations/system-settings.js"
import { makeAutomationRowReads } from "./automation-row-reads.js"
import { makeChosenThread } from "./automation-chosen-thread.js"
import { makeAutomationCreate } from "./automation-create.js"
import { makeAutomationUpdate } from "./automation-update.js"

export const makeAutomationCatalogEdits = ({
  writer,
  sessionEvents,
  rules
}: Pick<AutomationStoreDeps, "writer" | "sessionEvents" | "rules">): Pick<
  AutomationCatalog["Service"],
  "create" | "update" | "resetSystemSetting"
> => {
  const sql = writer.sql
  const { findAutomationRow } = makeAutomationRowReads({ writer, rules })

  const chosenThread = makeChosenThread({ sql, sessionEvents })
  const create = makeAutomationCreate({ writer, sessionEvents, rules })
  const update = makeAutomationUpdate({ writer, sessionEvents, rules, chosenThread })
  const resetSystemSetting = Effect.fn("SqliteAutomationStore.resetSystemSetting")(function* (
    automationId: string,
    setting: SystemAutomationSetting
  ): Effect.fn.Return<Automation | null, AutomationStoreError> {
    const validAutomationId = yield* automationIdEffect(automationId, "update")
    const row = yield* findAutomationRow(validAutomationId, "update")
    if (row === null) return null
    if (row.purpose !== JOB_PURPOSE.system) {
      return yield* storeError(
        "update",
        "invalid",
        "Only a system Automation has defaults to reset",
        validAutomationId
      )
    }
    const spec = yield* systemSpecOf(rules, row, "update")
    const resetTo = (change: AutomationChange) =>
      update(validAutomationId, { changes: [change] }, "agent")
    if (!systemSettable(spec).includes(setting))
      return yield* storeError(
        "update",
        "invalid",
        `This system Automation has no ${setting} to reset. It accepts only ${systemSettable(spec).join(", ")}.`,
        validAutomationId
      )
    switch (setting) {
      case "triggers":
        return yield* resetTo({ kind: "triggers", triggers: defaultTriggerInputs(spec.triggers) })
      case "model":
        return yield* resetTo({ kind: "model", model: { kind: "inherited" } })
      case "prompt":
        return yield* resetTo({ kind: "prompt", prompt: spec.prompt })
      case "enabled":
        return yield* resetTo({ kind: "enabled", enabled: spec.enabled })
    }
  })

  return { create, update, resetSystemSetting }
}
