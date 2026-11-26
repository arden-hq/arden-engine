import { AUTOMATION_CONTEXT_MODE } from "@arden-hq/protocol/automations"
import type { AutomationJobPayload } from "../persistence/automations/store.js"

export type AutomationModelSelection =
  | { readonly modelId: string }
  | { readonly modelRole: "background" }
  | Record<never, never>

export const automationModelSelection = (
  payload: Pick<AutomationJobPayload, "model" | "contextMode">
): AutomationModelSelection => {
  if (payload.contextMode === AUTOMATION_CONTEXT_MODE.fork) return {}
  if (payload.model !== null) return { modelId: payload.model }
  return { modelRole: "background" }
}
