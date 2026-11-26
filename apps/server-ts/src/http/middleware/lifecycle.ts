import { Effect } from "effect"
import {
  type HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http"
import { ServerLifecycle } from "../../runtime/lifecycle.js"

const READ_METHODS: ReadonlySet<HttpMethod.HttpMethod> = new Set(["GET", "HEAD", "OPTIONS"])

export const LifecycleMiddleware = HttpRouter.middleware(
  Effect.gen(function* () {
    const lifecycle = yield* ServerLifecycle
    return Effect.fn("LifecycleMiddleware")(function* <E, R>(
      httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (lifecycle.isAccepting() || READ_METHODS.has(request.method)) return yield* httpApp
      return HttpServerResponse.empty({ status: 503 })
    })
  }),
  { global: true }
)
