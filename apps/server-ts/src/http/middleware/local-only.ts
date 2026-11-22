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

const isLoopbackHostHeader = (value: string | undefined): boolean => {
  if (value === undefined) return false
  return isLoopbackHost(
    value.startsWith("[") ? value.slice(0, value.indexOf("]") + 1) : textBefore(value, ":")
  )
}

/** Chromium caps a cached preflight at two hours. */
const PREFLIGHT_MAX_AGE_SECONDS = 7_200

export interface LocalAccess {
  readonly host: "app" | "configured"
  readonly capability: string
  readonly rendererOrigin: string
  readonly cliCapability: string
  readonly phoneCapability: string
}

export const LocalCaller = Context.Reference<"desktop" | "cli" | "phone" | "other">(
  "@arden-hq/server/http/LocalCaller",
  { defaultValue: () => "other" }
)

/**
 * Whether this request comes from the Arden app itself, which alone grants what needs its own
 * consent (Touch ID, a typed secret). A caller's routes are `LocalCaller`'s; this is apart from them:
 * a configured server's owner reaches every route but has no app. Without local access nothing tells
 * callers apart, and every request counts as the app's.
 */
export const NativeConsent = Context.Reference<boolean>("@arden-hq/server/http/NativeConsent", {
  defaultValue: () => true
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

export const makeLocalOnlyMiddleware = (access?: LocalAccess) => {
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
            maxAge: PREFLIGHT_MAX_AGE_SECONDS,
            // The renderer's event streams send credentials: that keeps them in a
            // socket pool apart from its API reads. The daemon sets no cookies.
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
    let caller: typeof LocalCaller.Service = "other"
    if (desktop) caller = "desktop"
    else if (cli) caller = "cli"
    else if (phone) caller = "phone"
    const app = httpApp.pipe(
      Effect.provideService(LocalCaller, caller),
      Effect.provideService(
        NativeConsent,
        access === undefined || (desktop && access.host === "app")
      )
    )
    const origin = request.headers["origin"]
    if (origin === undefined) return authorized ? yield* app : yield* forbidden
    if (renderer === undefined || origin !== renderer.origin) return yield* forbidden
    return yield* renderer.cors(authorized ? app : forbidden)
  })
  return HttpRouter.middleware((httpApp) => guard(httpApp), { global: true })
}
