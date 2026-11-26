import {
  AUTOMATION_CHAT_CHOICE,
  AUTOMATION_CONTEXT_MODE,
  AUTOMATION_HISTORY,
  type AutomationChatChoice,
  type AutomationContextMode,
  type AutomationHistory
} from "@arden-hq/protocol/automations"
import { Effect } from "effect"
import type { AutomationStoreError } from "../automations/store.js"
import { storeError } from "./automation-rows.js"

export const historyContextMode = (history: AutomationHistory): "fresh" | "continue" =>
  history === AUTOMATION_HISTORY.chat
    ? AUTOMATION_CONTEXT_MODE.continue
    : AUTOMATION_CONTEXT_MODE.fresh

export const contextHistory = (contextMode: AutomationContextMode): AutomationHistory =>
  contextMode === AUTOMATION_CONTEXT_MODE.continue
    ? AUTOMATION_HISTORY.chat
    : AUTOMATION_HISTORY.fresh

export const setupModel = (input: {
  readonly chat: AutomationChatChoice["kind"]
  readonly history: AutomationHistory
  readonly requested: string | null | undefined
  readonly stored: string | null
  readonly operation: "create" | "update"
  readonly automationId?: string
}): Effect.Effect<string | null, AutomationStoreError> => {
  if (input.chat === AUTOMATION_CHAT_CHOICE.yours && input.history === AUTOMATION_HISTORY.chat) {
    return input.requested == null
      ? Effect.succeed(null)
      : Effect.fail(
          storeError(
            input.operation,
            "invalid",
            "An Automation that reads one of your chats runs on that chat's model",
            input.automationId
          )
        )
  }
  return Effect.succeed(input.requested === undefined ? input.stored : input.requested)
}
