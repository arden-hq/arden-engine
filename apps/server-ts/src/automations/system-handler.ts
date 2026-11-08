import type { makeChatOutcomeLinker } from "../routing/chat-outcome.js"
import type { Toolset } from "@arden-hq/loop"
import type { ChatMessage } from "../chat/message.js"
import type { RunCapability } from "../execution/policy.js"
import type { Memory } from "../memory/service.js"
import type {
  HandlerItemData,
  HandlerItemDataOf,
  HandlerItemKind
} from "../persistence/automations/handler-item.js"
import type { SystemAutomationSpec, SystemHandlerId } from "../persistence/automations/model.js"
import type { AutomationQueue } from "../persistence/automations/queue.js"
import type { HandlerItemOwnerId } from "../persistence/automations/store.js"
import type { HomeLetterInputs } from "../persistence/automations/home-letter-inputs.js"
import type { AutomationHandlerItems } from "../persistence/automations/handler-items.js"
import type { HomeStore } from "../persistence/home/store.js"
import type { SessionStore } from "../persistence/sessions/store.js"
import type { StoragePolicyStore } from "../persistence/storage/store.js"
import type { SummaryStore } from "../persistence/summaries/store.js"
import type { makeSpaceOverview } from "../memory/space-overview.js"
import type { TranscriptQueries } from "../persistence/transcript/queries.js"
import type { WikiMaintenanceStore } from "../persistence/wiki-maintenance/store.js"
import type { Wiki } from "../wiki/service.js"
import type { HandlerItemRunner } from "./handler-item-run.js"
import type { AutomationRunner, AwaitAutomationRun } from "./runner.js"

export interface SystemHandlerServices {
  readonly chat: ChatMessage["Service"]
  readonly queue: AutomationQueue["Service"]
  readonly homeLetterInputs: HomeLetterInputs["Service"]
  readonly handlerItems: AutomationHandlerItems["Service"]
  readonly home: HomeStore["Service"]
  readonly memory: Memory["Service"]
  readonly wiki: Wiki["Service"]
  readonly wikiMaintenance: WikiMaintenanceStore["Service"]
  readonly retentionPolicy: StoragePolicyStore["Service"]
  readonly sessions: SessionStore["Service"]
  readonly summaries: SummaryStore["Service"]
  readonly spaceOverview: ReturnType<typeof makeSpaceOverview>
  readonly linkOfferChat: ReturnType<typeof makeChatOutcomeLinker>
  readonly transcripts: TranscriptQueries["Service"]
  readonly awaitRun: AwaitAutomationRun
  readonly runItem: HandlerItemRunner
}

interface HandlerItemText {
  readonly kind: HandlerItemKind
  readonly text: (data: HandlerItemData) => string | undefined
}

export const isItemKind = <K extends HandlerItemKind>(
  kind: K,
  data: HandlerItemData
): data is HandlerItemDataOf<K> => data.kind === kind

export const handlerItemText = <K extends HandlerItemKind>(
  kind: K,
  text: (data: HandlerItemDataOf<K>) => string
): HandlerItemText => ({
  kind,
  text: (data) => (isItemKind(kind, data) ? text(data) : undefined)
})

export interface SystemAutomationHandler<Id extends SystemHandlerId = SystemHandlerId> {
  readonly spec: SystemAutomationSpec & { readonly handler: Id }
  readonly item?: Id extends HandlerItemOwnerId ? HandlerItemText : never
  readonly tools?: (base: Toolset) => Toolset
  readonly extraCapabilities?: ReadonlyArray<RunCapability>
  readonly run: (services: SystemHandlerServices) => AutomationRunner
}
