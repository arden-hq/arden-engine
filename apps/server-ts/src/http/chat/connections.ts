import { ConnectionResultRequestSchema } from "@arden-hq/protocol/effect/chat"
import { DECISION_DELIVERY } from "@arden-hq/protocol/runs"
import { Effect } from "effect"
import { HttpApiError } from "effect/unstable/httpapi"
import { ChatMessage } from "../../chat/message.js"
import { connectionChecks } from "../../connections/check.js"
import { ToolExecutionStore } from "../../persistence/tools/store.js"
import { DEFERRED_DECISION, DeferredCalls } from "../../tools/deferred-calls.js"
import { connectionCheckError, connectionStoreError, messageError } from "./errors.js"
import { connectionDeferredText, connectionResultText } from "./request-mapping.js"

export const connectionDecisions = Effect.gen(function* () {
  const message = yield* ChatMessage
  const tools = yield* ToolExecutionStore
  const deferred = yield* DeferredCalls
  const checkConnection = yield* connectionChecks
  const result = Effect.fn("ChatHandlers.connectionResult")(function* ({
    payload
  }: {
    readonly payload: typeof ConnectionResultRequestSchema.Type
  }) {
    const pending = yield* tools
      .pendingConnection({
        runId: payload.run_id,
        toolCallId: payload.tool_id
      })
      .pipe(Effect.mapError(connectionStoreError))
    if (pending === null) return yield* new HttpApiError.NotFound({})
    if (pending.snapshot.connection_id !== payload.connection_id) {
      return yield* new HttpApiError.Conflict({})
    }
    if (payload.approved) {
      yield* checkConnection(pending).pipe(Effect.mapError(connectionCheckError))
    }
    if (pending.snapshot.decision_delivery === DECISION_DELIVERY.deferred) {
      const decided = yield* deferred
        .decide({
          runId: payload.run_id,
          toolCallId: payload.tool_id,
          approved: payload.approved,
          result: connectionDeferredText(payload.result)
        })
        .pipe(Effect.mapError(connectionStoreError))
      if (decided !== DEFERRED_DECISION.decided) return yield* new HttpApiError.Conflict({})
      return { status: "ok" } as const
    }
    return yield* message
      .resolveTool({
        runId: payload.run_id,
        toolId: payload.tool_id,
        approved: payload.approved,
        result: connectionResultText(payload.result, payload.approved)
      })
      .pipe(Effect.mapError(messageError))
  })
  const resume = Effect.fn("ChatHandlers.connectionResume")(function* () {
    const pending = yield* tools.allPendingConnections().pipe(Effect.mapError(connectionStoreError))
    const resumed = yield* Effect.filter(pending, (decision) =>
      Effect.gen(function* () {
        yield* checkConnection(decision)
        if (decision.snapshot.decision_delivery === DECISION_DELIVERY.deferred) {
          yield* deferred.decide({
            runId: decision.snapshot.run_id,
            toolCallId: decision.snapshot.tool_id,
            approved: true,
            result: ""
          })
        } else {
          yield* message.resolveTool({
            runId: decision.snapshot.run_id,
            toolId: decision.snapshot.tool_id,
            approved: true,
            result: "connected"
          })
        }
        return true
      }).pipe(
        Effect.catchTag("ConnectionCheckError", () => Effect.succeed(false)),
        Effect.catch((error) =>
          Effect.logWarning("Connection resume skipped a paused call", {
            runId: decision.snapshot.run_id,
            toolId: decision.snapshot.tool_id,
            error
          }).pipe(Effect.as(false))
        )
      )
    )
    return {
      resumed: resumed.map(({ snapshot }) => ({
        run_id: snapshot.run_id,
        tool_id: snapshot.tool_id,
        connection_id: snapshot.connection_id
      }))
    }
  })
  return { result, resume }
})
