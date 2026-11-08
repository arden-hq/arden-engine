import { ToolExecutionError, failedToolResult } from "@arden-hq/loop"
import { Cause, Context, Effect, Layer, Scope } from "effect"
import { ServerLifecycle } from "../runtime/lifecycle.js"
import { ChatMessage } from "../chat/message.js"
import {
  DeferredToolCalls,
  deferredFollowUpId,
  type DeferredToolCall,
  type DeferredDecisionInput
} from "../persistence/tools/deferred.js"
import type { ToolExecutionStoreError } from "../persistence/tools/store.js"
import { ServerToolRegistry } from "./registry.js"

const FOLLOW_UP_FAILED = failedToolResult(
  new ToolExecutionError("The approved call could not run.", {
    preview: "Could not run",
    retryable: false
  })
)

export class DeferredCalls extends Context.Service<
  DeferredCalls,
  {
    readonly decide: (
      input: DeferredDecisionInput
    ) => Effect.Effect<"decided" | "not_deferred", ToolExecutionStoreError>
  }
>()("@arden-hq/server/tools/DeferredCalls") {
  static readonly layer = Layer.effect(
    DeferredCalls,
    Effect.gen(function* () {
      const store = yield* DeferredToolCalls
      const message = yield* ChatMessage
      const registry = yield* ServerToolRegistry
      const lifecycle = yield* ServerLifecycle
      const ownerScope = yield* Scope.Scope

      const runFollowUp = Effect.fn("DeferredCalls.runFollowUp")(function* (
        call: DeferredToolCall
      ) {
        const run = yield* message.detachedRun({ sessionId: call.sessionId, runId: call.runId })
        const toolset = yield* registry.runToolset(run)
        const toolCallId = deferredFollowUpId(call.toolCallId)
        const approval = {
          approved: true as const,
          feedback: null,
          ...(call.grantStanding === undefined ? {} : { grantStanding: call.grantStanding }),
          ...(call.data === undefined ? {} : { data: call.data })
        }
        const result = yield* Effect.promise(() =>
          run.executeDetachedTool(
            {
              toolCallId,
              name: call.toolName,
              args: call.arguments,
              changesState: call.changesState
            },
            () =>
              toolset.execute({
                toolCallId,
                name: call.toolName,
                args: call.arguments,
                approval
              })
          )
        )
        yield* store.recordRun({ runId: call.runId, toolCallId: call.toolCallId, result })
      })

      const start = Effect.fn("DeferredCalls.start")(function* (call: DeferredToolCall) {
        if (!lifecycle.isAccepting()) return
        yield* lifecycle.accepted(
          runFollowUp(call).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("An approved deferred call could not run", {
                runId: call.runId,
                toolCallId: call.toolCallId,
                cause
              }).pipe(
                Effect.andThen(
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : store
                        .recordRun({
                          runId: call.runId,
                          toolCallId: call.toolCallId,
                          result: FOLLOW_UP_FAILED
                        })
                        .pipe(
                          Effect.catchCause((recordCause) =>
                            Effect.logWarning("Could not close a failed deferred call", {
                              runId: call.runId,
                              toolCallId: call.toolCallId,
                              cause: recordCause
                            })
                          )
                        )
                )
              )
            )
          ),
          { scope: ownerScope }
        )
      })

      yield* lifecycle.background(
        Effect.gen(function* () {
          yield* store
            .rejectSidePending()
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not reject older Side chat approval cards", { cause })
              )
            )
          const unrun = yield* store
            .approvedUnrun()
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not list approved deferred calls", { cause }).pipe(
                  Effect.as([])
                )
              )
            )
          yield* Effect.forEach(unrun, start, { discard: true })
        })
      )

      const decide = Effect.fn("DeferredCalls.decide")(function* (input: DeferredDecisionInput) {
        const decision = yield* store.decide(input)
        switch (decision.kind) {
          case "not_deferred":
            return "not_deferred" as const
          case "settled":
            return "decided" as const
          case "approved":
            if (lifecycle.isAccepting()) yield* start(decision.call)
            return "decided" as const
        }
      })

      return DeferredCalls.of({ decide })
    })
  )
}
