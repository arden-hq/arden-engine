import { SERVER_BOOT_HEADER } from "@arden-hq/protocol/daemon"
import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { randomUUID } from "node:crypto"

export const BootIdMiddleware = HttpRouter.middleware(
  Effect.gen(function* () {
    const bootId = yield* Effect.sync(randomUUID)
    return (httpApp) =>
      Effect.map(httpApp, (response) =>
        HttpServerResponse.setHeader(response, SERVER_BOOT_HEADER, bootId)
      )
  }),
  { global: true }
)
