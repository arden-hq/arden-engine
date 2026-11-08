import { Context, type Effect } from "effect"
import type { HandlerItem, HandlerItemInput, HandlerItemRef } from "./handler-item.js"
import type { AutomationJobLeaseRef, AutomationStoreError } from "./store.js"

export class AutomationHandlerItems extends Context.Service<
  AutomationHandlerItems,
  {
    readonly prepareHandlerItem: (
      lease: AutomationJobLeaseRef,
      input: HandlerItemInput
    ) => Effect.Effect<HandlerItem, AutomationStoreError>
    readonly settleHandlerItem: (
      lease: AutomationJobLeaseRef,
      item: HandlerItemRef
    ) => Effect.Effect<HandlerItem, AutomationStoreError>
    readonly retryHandlerItem: (
      lease: AutomationJobLeaseRef,
      item: HandlerItemRef
    ) => Effect.Effect<HandlerItem, AutomationStoreError>
  }
>()("@arden-hq/server/persistence/automations/AutomationHandlerItems") {}
