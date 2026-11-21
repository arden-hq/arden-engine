import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { BrowserProcedureStore } from "../../persistence/browser-procedures/store.js"
import { BrowserProcedures } from "../../browser/procedures/service.js"
import { ArdenApi } from "../api.js"
import { failInternal } from "../errors.js"

export const BrowserProcedureHandlers = HttpApiBuilder.group(
  ArdenApi,
  "browserProcedures",
  Effect.fn("BrowserProcedureHandlers")(function* (handlers) {
    const store = yield* BrowserProcedureStore
    const procedures = yield* BrowserProcedures
    return handlers
      .handle("list", () => store.list().pipe(Effect.catch(failInternal("Browser procedures"))))
      .handle("detail", ({ params }) =>
        procedures.detail(params.id).pipe(
          Effect.catch(failInternal("Browser procedures")),
          Effect.flatMap((detail) =>
            detail === undefined
              ? Effect.fail(new HttpApiError.NotFound({}))
              : Effect.succeed(detail)
          )
        )
      )
      .handle("settings", ({ payload }) =>
        store
          .enable(payload.enabled)
          .pipe(Effect.as({ ok: true as const }), Effect.catch(failInternal("Browser procedures")))
      )
      .handle("enable", ({ params, payload }) =>
        store
          .enable(payload.enabled, params.id)
          .pipe(Effect.as({ ok: true as const }), Effect.catch(failInternal("Browser procedures")))
      )
  })
)
