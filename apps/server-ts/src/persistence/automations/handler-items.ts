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
    /**
     * Gives up on the item whose last try was Chat run `runId` when the Automation's give-up rule
     * holds: `tell` acts on the decision (skip the item or keep it) and answers the line that the
     * owner is told through the Automation's failed event. Answers that line, if it gave up.
     */
    readonly giveUp: (
      lease: AutomationJobLeaseRef,
      runId: string,
      tell: (decision: {
        readonly then: "skip" | "keep"
        readonly reason: string
      }) => Effect.Effect<string, Error>
    ) => Effect.Effect<string | undefined, Error>
  }
>()("@arden-hq/server/persistence/automations/AutomationHandlerItems") {}
