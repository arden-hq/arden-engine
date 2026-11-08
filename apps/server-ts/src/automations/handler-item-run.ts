import { Effect } from "effect"
import type { ChatMessage } from "../chat/message.js"
import type { TerminalAutomationChatRun } from "../persistence/automations/queue.js"
import type { AutomationJobLease } from "../persistence/automations/store.js"
import type { AutomationHandlerItems } from "../persistence/automations/handler-items.js"
import {
  MAX_HANDLER_ITEM_ATTEMPTS,
  handlerItemClientId,
  type HandlerItem
} from "../persistence/automations/handler-item.js"
import { handlerItemPrompt } from "./system.js"
import { startAutomationRun, type AwaitAutomationRun } from "./runner.js"

interface HandlerItemOutcome {
  readonly item: HandlerItem & { readonly runId: string }
  readonly state: "done" | "nothing_to_do" | "blocked" | "failed" | "cancelled"
  readonly detail: string | null
  readonly result: string | null
}
export type HandlerItemRunner = (
  job: AutomationJobLease,
  item: HandlerItem
) => Effect.Effect<HandlerItemOutcome, Error>

export const makeHandlerItemRunner = (services: {
  readonly chat: ChatMessage["Service"]
  readonly handlerItems: Pick<AutomationHandlerItems["Service"], "retryHandlerItem">
  readonly awaitRun: AwaitAutomationRun
}): HandlerItemRunner =>
  Effect.fn("HandlerItemRunner")(function* (
    job: AutomationJobLease,
    initial: HandlerItem
  ): Effect.fn.Return<HandlerItemOutcome, Error> {
    let item = initial
    while (true) {
      let runId = item.runId
      if (runId === null) {
        const receipt = yield* startAutomationRun(services.chat, job, {
          handlerItem: { id: item.id, attempt: item.attempt },
          sessionId: item.input.sessionId,
          clientId: handlerItemClientId(item),
          prompt: handlerItemPrompt(item.input),
          name: item.input.name
        })
        if (receipt.runId === null) throw new Error("Handler Chat Run has no identity")
        runId = receipt.runId
      }
      const observed = yield* services.awaitRun(runId)
      const retryable =
        observed.status !== "cancelled" &&
        (observed.status === "failed" || observed.blocked?.kind === "transient")
      if (retryable && item.attempt < MAX_HANDLER_ITEM_ATTEMPTS) {
        item = yield* services.handlerItems.retryHandlerItem(job, item)
        yield* Effect.sleep("500 millis")
        continue
      }
      return { item: { ...item, runId }, result: observed.result, ...describeOutcome(observed) }
    }
  })

const describeOutcome = (
  observed: TerminalAutomationChatRun
): Pick<HandlerItemOutcome, "state" | "detail"> => {
  if (observed.status === "cancelled") return { state: "cancelled", detail: observed.error }
  if (observed.status === "failed") return { state: "failed", detail: observed.error }
  if (observed.blocked !== null) return { state: "blocked", detail: observed.blocked.reason }
  return { state: observed.wrote ? "done" : "nothing_to_do", detail: null }
}
