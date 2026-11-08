import { Effect } from "effect"
import type {
  HandlerItem,
  HandlerItemDataOf,
  HandlerItemKind
} from "../persistence/automations/handler-item.js"
import {
  jobHandlerItem,
  type AutomationJobLease,
  type AutomationJobResult
} from "../persistence/automations/store.js"
import type { AutomationHandlerItems } from "../persistence/automations/handler-items.js"
import type { HandlerItemRunner } from "./handler-item-run.js"
import { jobResult, type AutomationRunner } from "./runner.js"
import { isItemKind } from "./system-handler.js"

interface ItemLoop<K extends HandlerItemKind> {
  readonly label: string
  readonly kind: K
  readonly next: () => Effect.Effect<HandlerItemDataOf<K> | "idle" | "advance", Error>
  readonly commit: (data: HandlerItemDataOf<K>) => Effect.Effect<void, Error>
  readonly summary: (item: HandlerItem | undefined) => string
  readonly cancelled: string
  readonly incomplete: string
}

export const runItemLoop = <K extends HandlerItemKind>(
  services: {
    readonly handlerItems: Pick<
      AutomationHandlerItems["Service"],
      "prepareHandlerItem" | "settleHandlerItem"
    >
    readonly runItem: HandlerItemRunner
  },
  loop: ItemLoop<K>
): AutomationRunner =>
  Effect.fn("AutomationItemLoop")(function* (
    job: AutomationJobLease
  ): Effect.fn.Return<AutomationJobResult, Error> {
    let item = jobHandlerItem(job.payload)
    const sessionId =
      item?.input.sessionId ?? job.payload.chatRun?.sessionId ?? job.payload.sessionId
    if (sessionId === null) throw new Error(`${loop.label} has no Chat session`)
    let lastRunId = item?.runId ?? item?.previousRunId ?? job.payload.chatRun?.runId ?? null
    const run = () => ({ chatRunId: lastRunId, chatSessionId: sessionId })
    const finished = (error: string | null, result = loop.summary(item)): AutomationJobResult =>
      error === null
        ? jobResult.completed("finished", result, run())
        : jobResult.failed(error, result, run())
    while (true) {
      if (item?.phase === "settled" && item.failure !== null) return finished(item.failure)
      if (item?.phase !== "pending") {
        const next = yield* loop.next()
        if (next === "idle") {
          return lastRunId === null
            ? jobResult.withoutRun("no_input", loop.summary(item))
            : jobResult.completed("finished", loop.summary(item), run())
        }
        if (next === "advance") continue
        item = yield* services.handlerItems.prepareHandlerItem(job, {
          sessionId,
          name: item?.input.name ?? job.payload.name,
          instructions: item?.input.instructions ?? job.payload.prompt,
          data: next
        })
      }
      const data = item.input.data
      if (!isItemKind(loop.kind, data))
        throw new Error(`${loop.label} received another handler's item`)
      const outcome = yield* services.runItem(job, item)
      lastRunId = outcome.item.runId
      if (outcome.state === "cancelled")
        return finished(outcome.detail ?? loop.cancelled, outcome.result ?? loop.summary(item))
      if (outcome.state === "failed" || outcome.state === "blocked") {
        item = yield* services.handlerItems.settleHandlerItem(job, outcome.item)
        return finished(outcome.detail ?? loop.incomplete)
      }
      yield* loop.commit(data)
      item = yield* services.handlerItems.settleHandlerItem(job, outcome.item)
    }
  })
