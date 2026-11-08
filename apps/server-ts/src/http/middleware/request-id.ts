import { Cause, Effect } from "effect"
import {
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http"
import { randomUUID } from "node:crypto"

const UUID_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const isRequestId = (value: string | undefined): value is string =>
  value !== undefined && UUID_REQUEST_ID.test(value)

const withRequestId = Effect.fn("RequestIdMiddleware")(function* <E, R>(
  httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
) {
  const request = yield* HttpServerRequest.HttpServerRequest
  const suppliedRequestId = request.headers["x-request-id"]
  const requestId = isRequestId(suppliedRequestId)
    ? suppliedRequestId
    : yield* Effect.sync(randomUUID)
  const response = yield* httpApp.pipe(
    Effect.annotateLogs("request_id", requestId),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logError(cause).pipe(
            Effect.andThen(HttpServerError.causeResponse(cause)),
            Effect.map(([response]) => response)
          )
    )
  )
  if (response.status >= 500) {
    yield* Effect.logError("Request answered 5xx").pipe(
      Effect.annotateLogs({
        request_id: requestId,
        method: request.method,
        resource: `/${request.url.split(/[/?#]/).find((segment) => segment !== "") ?? ""}`,
        status: response.status
      })
    )
  }
  return HttpServerResponse.setHeader(response, "x-request-id", requestId)
})

export const RequestIdMiddleware = HttpRouter.middleware((httpApp) => withRequestId(httpApp), {
  global: true
})
