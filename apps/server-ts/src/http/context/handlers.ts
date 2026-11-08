import { ContextExperiments } from "../../context/experiments.js"
import { LocalCaller } from "../middleware/local-only.js"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import {
  ContextCompaction,
  ContextCompactionError,
  type ManualCompactionResult
} from "../../context/service.js"
import { ArdenApi } from "../api.js"
import { storeErrorToHttp } from "../errors.js"

const mapError = (cause: ContextCompactionError) => {
  if (cause.reason === "provider") return new HttpApiError.ServiceUnavailable({})
  return storeErrorToHttp({ reason: cause.reason, message: cause.message })
}

const response = (result: ManualCompactionResult) => {
  switch (result.status) {
    case "no_session":
      return result
    case "nothing_to_compact":
      return {
        status: result.status,
        message: result.message,
        message_count: result.messageCount,
        before_tokens: result.beforeTokens
      } as const
    case "compacted":
      return {
        status: result.status,
        message: result.message,
        before_tokens: result.beforeTokens,
        before_messages: result.beforeMessages,
        after_messages: result.afterMessages,
        messages_compressed: result.messagesCompressed
      } as const
  }
}

export const ContextHandlers = HttpApiBuilder.group(
  ArdenApi,
  "context",
  Effect.fn(function* (handlers) {
    const compaction = yield* ContextCompaction
    const experiments = yield* ContextExperiments
    return handlers
      .handle(
        "experiments",
        Effect.fn("Context.experiments")(function* ({ params }) {
          if ((yield* LocalCaller) !== "desktop") return yield* new HttpApiError.Forbidden({})
          return experiments.report(params.sessionId)
        })
      )
      .handle(
        "selectContext",
        Effect.fn("Context.selectContext")(function* ({ params, payload }) {
          if ((yield* LocalCaller) !== "desktop") return yield* new HttpApiError.Forbidden({})
          experiments.set(params.sessionId, payload)
          return experiments.report(params.sessionId)
        })
      )
      .handle("compact", ({ payload }) =>
        compaction.manual(payload.session_id).pipe(Effect.map(response), Effect.mapError(mapError))
      )
  })
)
