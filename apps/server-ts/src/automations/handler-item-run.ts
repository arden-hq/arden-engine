import { OBSERVED_RUN } from "../persistence/automations/queue.js"
import { Effect } from "effect"
import type { ChatMessage } from "../chat/message.js"
import type { TerminalAutomationChatRun } from "../persistence/automations/queue.js"
import type { AutomationJobLease } from "../persistence/automations/store.js"
import type { AutomationHandlerItems } from "../persistence/automations/handler-items.js"
import {
  HANDLER_OUTCOME,
  handlerItemClientId,
  type HandlerItem
} from "../persistence/automations/handler-item.js"
import { handlerItemPrompt } from "./system.js"
import { retried } from "./job-run.js"
import { startAutomationRun, type AwaitAutomationRun } from "./runner.js"

interface HandlerItemOutcome {
  readonly item: HandlerItem & { readonly runId: string }
  readonly state: (typeof HANDLER_OUTCOME)[keyof typeof HANDLER_OUTCOME]
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
    const run = Effect.fn("HandlerItemRunner.run")(function* () {
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
      return { ...(yield* services.awaitRun(runId)), runId }
    })
    const observed = yield* retried(yield* run(), item.attempt, () =>
      services.handlerItems.retryHandlerItem(job, item).pipe(
        Effect.flatMap((next) => {
          item = next
          return run()
        })
      )
    )
    return {
      item: { ...item, runId: observed.runId },
      result: observed.result,
      ...describeOutcome(observed)
    }
  })

const describeOutcome = (
  observed: TerminalAutomationChatRun
): Pick<HandlerItemOutcome, "state" | "detail"> => {
  if (observed.status === OBSERVED_RUN.cancelled)
    return { state: HANDLER_OUTCOME.cancelled, detail: observed.error }
  if (observed.status === OBSERVED_RUN.failed)
    return { state: HANDLER_OUTCOME.failed, detail: observed.error }
  if (observed.blocked !== null)
    return { state: HANDLER_OUTCOME.blocked, detail: observed.blocked.reason }
  return {
    state: observed.wrote ? HANDLER_OUTCOME.done : HANDLER_OUTCOME.nothingToDo,
    detail: null
  }
}
