import { ToolExecutionError } from "@arden-hq/loop"
import type { Automation } from "@arden-hq/protocol/automations"
import { Effect } from "effect"
import type { AutomationCatalog } from "../persistence/automations/catalog.js"
import type { AutomationStoreError } from "../persistence/automations/store.js"
import type { MakeMutationReceiptInput } from "../persistence/tools/mutation-receipt.js"
import { toolFailure } from "./tool-failure.js"

const failurePreview = (error: AutomationStoreError): string => {
  switch (error.reason) {
    case "invalid":
      return "Invalid Automation request"
    case "not_found":
      return "Automation not found"
    case "conflict":
      return "Automation changed"
    case "corrupt":
      return "Automation data is corrupt"
    case "storage":
      return "Automations unavailable"
  }
}

export const storeFailure = (error: AutomationStoreError): ToolExecutionError =>
  toolFailure(error, failurePreview(error))

export const resolveAutomation = async (
  store: AutomationCatalog["Service"],
  automationRef: string,
  signal: AbortSignal
): Promise<Automation> => {
  const automations = await Effect.runPromise(store.list().pipe(Effect.mapError(storeFailure)), {
    signal
  })
  const automation = automations.find((candidate) => candidate.automation_ref === automationRef)
  if (automation !== undefined) return automation
  throw new ToolExecutionError(`No Automation ${automationRef}`, {
    preview: "Automation not found",
    retryable: false
  })
}

export const lastAutomationVersion = (
  store: AutomationCatalog["Service"],
  automation: Pick<Automation, "task_id">,
  signal: AbortSignal
): Promise<number | undefined> =>
  Effect.runPromise(
    store.history({ id: automation.task_id, limit: 1 }).pipe(
      Effect.map((page) => page.through_version),
      Effect.orElseSucceed(() => undefined)
    ),
    { signal }
  )

type Resource = Extract<
  MakeMutationReceiptInput["resource"],
  { readonly kind: "versioned_resource" | "target" }
>

interface NamedAutomation {
  readonly task_id: string
  readonly automation_ref: string
  readonly name: string
}

const automationLabel = (automation: NamedAutomation, title: string) => ({
  resourceRef: `automation:${automation.task_id}`,
  domain: "automation" as const,
  title,
  href: `arden:automation/${encodeURIComponent(automation.automation_ref)}`
})

export const automationResource = (
  automation: NamedAutomation,
  title: string = automation.name
): Resource => ({ kind: "target", ...automationLabel(automation, title) })

export const deletedAutomationResource = (
  automation: NamedAutomation,
  lastVersion: number | undefined
): Resource =>
  lastVersion === undefined || lastVersion < 1
    ? automationResource(automation)
    : {
        kind: "versioned_resource",
        ...automationLabel(automation, automation.name),
        beforeVersion: String(lastVersion),
        afterVersion: "absent"
      }
