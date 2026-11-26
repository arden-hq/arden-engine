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
import { HANDLER_ITEM_PHASE, HANDLER_OUTCOME } from "../persistence/automations/handler-item.js"
import { ITEM_GIVE_UP } from "../persistence/sqlite/automation-auto-pause.js"

import type { AutomationHandlerItems } from "../persistence/automations/handler-items.js"
import type { HandlerItemRunner } from "./handler-item-run.js"
import { jobResult, type AutomationRunner } from "./runner.js"
import { isItemKind } from "./system-handler.js"

const ITEM_NEXT = { idle: "idle", advance: "advance" } as const

interface ItemLoop<K extends HandlerItemKind> {
  readonly label: string
  readonly kind: K
  readonly next: () => Effect.Effect<
    HandlerItemDataOf<K> | typeof ITEM_NEXT.idle | typeof ITEM_NEXT.advance,
    Error
  >
  readonly commit: (data: HandlerItemDataOf<K>) => Effect.Effect<void, Error>
  readonly skip: (data: HandlerItemDataOf<K>) => Effect.Effect<string, Error>
  readonly summary: (item: HandlerItem | undefined) => string
  readonly cancelled: string
  readonly incomplete: string
}

export interface ItemLoopServices {
  readonly handlerItems: Pick<
    AutomationHandlerItems["Service"],
    "prepareHandlerItem" | "settleHandlerItem" | "giveUp"
  >
  readonly runItem: HandlerItemRunner
}

export const runItemLoop = <K extends HandlerItemKind>(
  services: ItemLoopServices,
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
    const failed = Effect.fn("AutomationItemLoop.failed")(function* (
      settled: HandlerItem & { readonly runId: string },
      detail: string | null
    ) {
      const data = settled.input.data
      if (!isItemKind(loop.kind, data)) return finished(detail ?? loop.incomplete)
      const told = yield* services.handlerItems.giveUp(job, settled.runId, (decision) =>
        decision.then === ITEM_GIVE_UP.streak
          ? loop
              .skip(data)
              .pipe(Effect.map((item) => `${loop.label} skipped ${item}: ${decision.reason}`))
          : Effect.succeed(
              `${loop.label} could not run: ${decision.reason} It tries the same work again on its next run.`
            )
      )
      return finished(told ?? detail ?? loop.incomplete)
    })
    while (true) {
      if (item?.phase === HANDLER_ITEM_PHASE.settled && item.failure !== null)
        return yield* failed(item, item.failure)
      if (item?.phase !== HANDLER_ITEM_PHASE.pending) {
        const next = yield* loop.next()
        if (next === ITEM_NEXT.idle) {
          return lastRunId === null
            ? jobResult.withoutRun("no_input", loop.summary(item))
            : jobResult.completed("finished", loop.summary(item), run())
        }
        if (next === ITEM_NEXT.advance) continue
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
      if (outcome.state === HANDLER_OUTCOME.cancelled)
        return finished(outcome.detail ?? loop.cancelled, outcome.result ?? loop.summary(item))
      if (outcome.state === HANDLER_OUTCOME.failed || outcome.state === HANDLER_OUTCOME.blocked) {
        item = yield* services.handlerItems.settleHandlerItem(job, outcome.item)
        return yield* failed(outcome.item, outcome.detail)
      }
      yield* loop.commit(data)
      item = yield* services.handlerItems.settleHandlerItem(job, outcome.item)
    }
  })
