import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { FocusChoiceStore } from "../../persistence/focus-choices/store.js"
import { ArdenApi } from "../api.js"
import { failStore } from "../errors.js"

export const FocusChoiceHandlers = HttpApiBuilder.group(
  ArdenApi,
  "focusChoices",
  Effect.fn("FocusChoiceHandlers")(function* (handlers) {
    const choices = yield* FocusChoiceStore
    return handlers
      .handle("get", ({ params }) =>
        choices.get(params.spaceId, params.questionId).pipe(Effect.catch(failStore))
      )
      .handle("resolve", ({ params, payload }) =>
        choices.resolve(params.spaceId, params.questionId, payload).pipe(Effect.catch(failStore))
      )
  })
)
