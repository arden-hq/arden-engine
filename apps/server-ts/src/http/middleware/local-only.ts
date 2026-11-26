import { LOCAL_CAPABILITY_HEADER, SERVER_BOOT_HEADER } from "@arden-hq/protocol/daemon"
import {
  CHAT_OPEN_TIMING_REQUEST_HEADER,
  CHAT_OPEN_TIMING_RESPONSE_HEADER
} from "@arden-hq/protocol/chat-open-timing"
import { isLoopbackHost } from "@arden-hq/std/url"
import { Context, Effect } from "effect"
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http"
import { timingSafeEqual } from "node:crypto"
import { textBefore } from "../../lib/text.js"
import type { Layer } from "effect/Layer"

const isLoopbackHostHeader = (value: string | undefined): boolean => {
  if (value === undefined) return false
  return isLoopbackHost(
    value.startsWith("[") ? value.slice(0, value.indexOf("]") + 1) : textBefore(value, ":")
  )
}

// https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Max-Age
const CHROMIUM_PREFLIGHT_MAX_AGE_CAP_SECONDS = 7_200

export const LOCAL_ACCESS_HOST = { app: "app", configured: "configured" } as const

type LocalAccessHost = (typeof LOCAL_ACCESS_HOST)[keyof typeof LOCAL_ACCESS_HOST]

export interface LocalAccess {
  readonly host: LocalAccessHost
  readonly capability: string
  readonly rendererOrigin: string
  readonly cliCapability: string
  readonly phoneCapability: string
}

export const LOCAL_CALLER = {
  desktop: "desktop",
  cli: "cli",
  phone: "phone",
  other: "other"
} as const

export type LocalCallerKind = (typeof LOCAL_CALLER)[keyof typeof LOCAL_CALLER]

export const LocalCaller = Context.Reference<LocalCallerKind>("@arden-hq/server/http/LocalCaller", {
  defaultValue: () => LOCAL_CALLER.other
})

export const CallerIsTheApp = Context.Reference<boolean>("@arden-hq/server/http/CallerIsTheApp", {
  defaultValue: () => false
})

const matchesLocalCapability = (expected: string, provided: string | undefined): boolean => {
  if (provided === undefined) return false
  const expectedBytes = Buffer.from(expected, "utf8")
  const providedBytes = Buffer.from(provided, "utf8")
  return (
    expectedBytes.byteLength === providedBytes.byteLength &&
    timingSafeEqual(expectedBytes, providedBytes)
  )
}

export const makeLocalOnlyMiddleware = (
  access?: LocalAccess
): Layer<never, never, HttpRouter.HttpRouter> => {
  const renderer =
    access === undefined
      ? undefined
      : {
          origin: access.rendererOrigin,
          cors: HttpMiddleware.cors({
            allowedOrigins: [access.rendererOrigin],
            allowedHeaders: [
              "content-type",
              LOCAL_CAPABILITY_HEADER,
              "x-request-id",
              CHAT_OPEN_TIMING_REQUEST_HEADER
            ],
            exposedHeaders: [SERVER_BOOT_HEADER, "x-request-id", CHAT_OPEN_TIMING_RESPONSE_HEADER],
            maxAge: CHROMIUM_PREFLIGHT_MAX_AGE_CAP_SECONDS,
            credentials: true
          })
        }
  const forbidden = Effect.succeed(HttpServerResponse.empty({ status: 403 }))
  const guard = Effect.fn("LocalOnlyMiddleware")(function* <E, R>(
    httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!isLoopbackHostHeader(request.headers["host"])) return yield* forbidden
    const provided = request.headers[LOCAL_CAPABILITY_HEADER]
    const desktop = access !== undefined && matchesLocalCapability(access.capability, provided)
    const cli = access !== undefined && matchesLocalCapability(access.cliCapability, provided)
    const phone = access !== undefined && matchesLocalCapability(access.phoneCapability, provided)
    const authorized = access === undefined || desktop || cli || phone
    let caller: LocalCallerKind = LOCAL_CALLER.other
    if (desktop) caller = LOCAL_CALLER.desktop
    else if (cli) caller = LOCAL_CALLER.cli
    else if (phone) caller = LOCAL_CALLER.phone
    const app = httpApp.pipe(
      Effect.provideService(LocalCaller, caller),
      Effect.provideService(CallerIsTheApp, desktop && access.host === LOCAL_ACCESS_HOST.app)
    )
    const origin = request.headers["origin"]
    if (origin === undefined) return authorized ? yield* app : yield* forbidden
    if (renderer === undefined || origin !== renderer.origin) return yield* forbidden
    return yield* renderer.cors(authorized ? app : forbidden)
  })
  return HttpRouter.middleware((httpApp) => guard(httpApp), { global: true })
}
