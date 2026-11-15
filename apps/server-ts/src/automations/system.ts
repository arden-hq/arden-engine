import type { HandlerItemInput, HandlerItemKind } from "../persistence/automations/handler-item.js"
import {
  SYSTEM_HANDLER_IDS,
  type SystemAutomationSpec,
  type SystemHandlerId
} from "../persistence/automations/model.js"
import { chatSummariesHandler } from "./handlers/chat-summaries.js"
import { dailySummaryHandler } from "./handlers/daily-summary.js"
import { homeLetterHandler } from "./handlers/home-letter.js"
import { managedHistoryHandler } from "./handlers/managed-history.js"
import { memoryCaptureHandler } from "./handlers/memory-capture.js"
import { wikiMaintenanceHandler } from "./handlers/wiki-maintenance.js"
import type { SystemAutomationHandler } from "./system-handler.js"
import type { AutomationId } from "../persistence/automations/model.js"

export const SYSTEM_HANDLERS: { readonly [Id in SystemHandlerId]: SystemAutomationHandler<Id> } = {
  memory_capture: memoryCaptureHandler,
  daily_summary: dailySummaryHandler,
  home_letter: homeLetterHandler,
  managed_history_collection: managedHistoryHandler,
  wiki_maintenance: wikiMaintenanceHandler,
  chat_summaries: chatSummariesHandler
}

const handlers: ReadonlyArray<SystemAutomationHandler> = SYSTEM_HANDLER_IDS.map(
  (id) => SYSTEM_HANDLERS[id]
)

export const SYSTEM_AUTOMATION_SPECS: ReadonlyArray<SystemAutomationSpec> = handlers.map(
  (handler) => handler.spec
)

const isSystemHandlerId = (handler: string): handler is SystemHandlerId =>
  SYSTEM_HANDLER_IDS.some((id) => id === handler)

export const systemSpec = (handler: string): SystemAutomationSpec | undefined =>
  isSystemHandlerId(handler) ? SYSTEM_HANDLERS[handler].spec : undefined

export const systemHandlerForAutomation = (
  automationId: AutomationId | null
): SystemAutomationHandler | undefined =>
  handlers.find((handler) => handler.spec.automationId === automationId)

const itemOwners = new Map<HandlerItemKind, SystemHandlerId>()
for (const handler of handlers) {
  if (handler.item === undefined) continue
  const owner = itemOwners.get(handler.item.kind)
  if (owner !== undefined) {
    throw new Error(
      `Handler item kind "${handler.item.kind}" has two owners: ${owner}, ${handler.spec.handler}`
    )
  }
  itemOwners.set(handler.item.kind, handler.spec.handler)
}

export const handlerItemOwner = (kind: HandlerItemKind): SystemHandlerId => {
  const owner = itemOwners.get(kind)
  if (owner === undefined) throw new Error(`No system handler owns "${kind}" handler items`)
  return owner
}

export const handlerItemPrompt = (input: HandlerItemInput): string => {
  const item = SYSTEM_HANDLERS[handlerItemOwner(input.data.kind)].item
  const text = item?.text(input.data)
  if (text === undefined)
    throw new Error(`No system handler renders "${input.data.kind}" handler items`)
  return `${input.instructions}\n\n${text}`
}
