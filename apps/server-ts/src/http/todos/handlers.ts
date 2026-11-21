import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { TodoStore } from "../../persistence/todos/store.js"
import { ArdenApi } from "../api.js"
import { failInternal, failStore } from "../errors.js"

export const TodoHandlers = HttpApiBuilder.group(
  ArdenApi,
  "todos",
  Effect.fn("TodoHandlers")(function* (handlers) {
    const store = yield* TodoStore

    return handlers
      .handle("get", ({ params }) =>
        store.get(params.sessionId).pipe(Effect.catch(failInternal("Todos")))
      )
      .handle("set", ({ params, payload }) =>
        store.setOverride(params.sessionId, payload).pipe(Effect.catch(failStore))
      )
      .handle("clear", ({ params }) =>
        store.clear(params.sessionId).pipe(Effect.catch(failInternal("Todos")))
      )
      .handle("clearOverride", ({ params }) =>
        store.clearOverride(params.sessionId).pipe(Effect.catch(failInternal("Todos")))
      )
  })
)
