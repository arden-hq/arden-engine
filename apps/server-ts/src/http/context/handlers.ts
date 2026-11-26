import { CONTEXT_COMPACTION_STATUS } from "@arden-hq/protocol/context"
import { CONTEXT_COMPACTION_FAILURE } from "../../context/service.js"
import { ContextExperiments } from "../../context/experiments.js"
import { LOCAL_CALLER, LocalCaller } from "../middleware/local-only.js"
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
  if (cause.reason === CONTEXT_COMPACTION_FAILURE.provider)
    return new HttpApiError.ServiceUnavailable({})
  return storeErrorToHttp({ reason: cause.reason, message: cause.message })
}

const response = (result: ManualCompactionResult) => {
  switch (result.status) {
    case CONTEXT_COMPACTION_STATUS.noSession:
      return result
    case CONTEXT_COMPACTION_STATUS.nothingToCompact:
      return {
        status: result.status,
        message: result.message,
        message_count: result.messageCount
      } as const
    case CONTEXT_COMPACTION_STATUS.compacted:
      return {
        status: result.status,
        message: result.message,
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
          if ((yield* LocalCaller) !== LOCAL_CALLER.desktop)
            return yield* new HttpApiError.Forbidden({})
          return experiments.report(params.sessionId)
        })
      )
      .handle(
        "selectContext",
        Effect.fn("Context.selectContext")(function* ({ params, payload }) {
          if ((yield* LocalCaller) !== LOCAL_CALLER.desktop)
            return yield* new HttpApiError.Forbidden({})
          experiments.set(params.sessionId, payload)
          return experiments.report(params.sessionId)
        })
      )
      .handle("compact", ({ payload }) =>
        compaction.manual(payload.session_id).pipe(Effect.map(response), Effect.mapError(mapError))
      )
  })
)
