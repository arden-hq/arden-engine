import { ToolExecutionError } from "@arden-hq/loop"
import {
  AUTOMATION_HISTORY,
  automationPermissionChat,
  type Automation,
  type AutomationChatChoice
} from "@arden-hq/protocol/automations"
import {
  AutomationModelSchema,
  AutomationSchema,
  SystemAutomationChatSchema
} from "@arden-hq/protocol/effect/automations"
import { Effect } from "effect"
import { CREATE_CHAT } from "./automation-tool-schema.js"
import { McpConnections } from "../mcp/service.js"
import type { AutomationRuntime } from "../automations/runtime.js"
import { AutomationCatalog } from "../persistence/automations/catalog.js"
import { SessionQueries, type SessionQueryFailure } from "../persistence/sessions/queries.js"
import { SessionStore } from "../persistence/sessions/store.js"
import { ModelStore, type ModelStoreError } from "../persistence/models/store.js"
import { LimitSettingsStore } from "../persistence/settings/store.js"
import {
  ApprovalPolicyStore,
  sessionApprovalMode,
  type ApprovalPolicyError
} from "../persistence/permissions/approval-policy.js"
import { toolFailure } from "./tool-failure.js"
import { type AutomationModelInfo } from "./automation-tool-text.js"
import { historyOf } from "./automation-tool-data.js"
import { resolveChatRef } from "./automation-records.js"

export interface AutomationToolServices {
  readonly store: AutomationCatalog["Service"]
  readonly runNow: AutomationRuntime["Service"]["runNow"]
  readonly sessions: SessionQueries["Service"]
  readonly sessionStore: SessionStore["Service"]
  readonly models: ModelStore["Service"]
  readonly policy: ApprovalPolicyStore["Service"]
  readonly limits: LimitSettingsStore["Service"]
  readonly apps: McpConnections["Service"]["snapshot"]
}

export const automationGuards = AutomationSchema.guards
export const chatGuards = SystemAutomationChatSchema.guards

const sessionFailure = (error: SessionQueryFailure): ToolExecutionError =>
  toolFailure(
    { reason: error.reason, message: `Could not read the Automation's chat: ${error.message}` },
    "Chat unavailable"
  )

export const modelFailure = (error: ModelStoreError): ToolExecutionError =>
  toolFailure(error, "Model unavailable")

export const policyFailure = (error: ApprovalPolicyError): ToolExecutionError =>
  toolFailure(error, "Chat permissions unavailable")

export const automationModelInfo = async (
  automation: Automation,
  services: AutomationToolServices,
  signal: AbortSignal
): Promise<AutomationModelInfo> => {
  const chat = automation.chat
  const runChat = chatGuards.none(chat)
    ? null
    : await Effect.runPromise(
        services.sessions.loadHistoryHeader(chat.session_id).pipe(Effect.mapError(sessionFailure)),
        { signal }
      )
  const permissionChat = automationPermissionChat(automation)
  const permission =
    permissionChat === null
      ? null
      : await Effect.runPromise(
          services.policy.session(permissionChat).pipe(Effect.mapError(policyFailure)),
          { signal }
        )
  const context = {
    chat_ref: chatGuards.yours(chat) ? (runChat?.publicRef ?? null) : null,
    action_mode: permission && sessionApprovalMode(permission)
  }
  if (automationGuards.system(automation) && !automation.settings.settable.includes("model")) {
    return { ...context, model_source: "source_chat", effective_model: null }
  }
  if (AutomationModelSchema.guards.chosen(automation.model)) {
    return { ...context, model_source: "override", effective_model: automation.model.model_id }
  }
  if (chatGuards.yours(chat) && historyOf(automation) === AUTOMATION_HISTORY.chat) {
    if (runChat === null) return { ...context, model_source: "unknown", effective_model: null }
    const selection = await Effect.runPromise(
      services.models.selection(runChat.sessionId).pipe(Effect.mapError(modelFailure)),
      { signal }
    )
    return { ...context, model_source: "chat", effective_model: selection.modelId }
  }
  const settings = await Effect.runPromise(
    services.models.snapshot().pipe(Effect.mapError(modelFailure)),
    { signal }
  )
  return {
    ...context,
    model_source: "background",
    effective_model: settings.roleOverrides.background.modelId
  }
}

export const chosenChat = async (
  choice: { readonly where: "current" | "own" | undefined; readonly chat_ref: string | undefined },
  services: AutomationToolServices,
  currentSessionId: string,
  signal: AbortSignal
): Promise<AutomationChatChoice> => {
  if (choice.chat_ref === undefined) {
    return choice.where === CREATE_CHAT.own
      ? { kind: "own" }
      : { kind: "yours", session_id: currentSessionId }
  }
  if (choice.where === CREATE_CHAT.own) {
    throw new ToolExecutionError("Choose chat=own or a chat_ref, not both", {
      preview: "Conflicting chat",
      retryable: false
    })
  }
  const target = await resolveChatRef(services.sessionStore, choice.chat_ref, signal)
  return { kind: "yours", session_id: target.sessionId }
}
