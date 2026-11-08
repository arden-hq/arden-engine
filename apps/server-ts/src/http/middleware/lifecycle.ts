import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ServerLifecycle } from "../../runtime/lifecycle.js"

export const LifecycleMiddleware = HttpRouter.middleware(
  Effect.gen(function* () {
    const lifecycle = yield* ServerLifecycle
    return Effect.fn("LifecycleMiddleware")(function* <E, R>(
      httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (
        lifecycle.isAccepting() ||
        request.method === "GET" ||
        request.method === "HEAD" ||
        request.method === "OPTIONS"
      )
        return yield* httpApp
      return HttpServerResponse.empty({ status: 503 })
    })
  }),
  { global: true }
)
