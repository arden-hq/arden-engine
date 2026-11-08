import { Effect, Predicate } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

import { SessionStore } from "../../persistence/sessions/store.js"
import { LocalCaller } from "./local-only.js"

type Requirement =
  | { readonly kind: "open" }
  /** The chat, or the chat of the run, is one the command line made. */
  | {
      readonly kind: "own"
      readonly target: { readonly sessionId: string } | { readonly runId: string }
    }
  | { readonly kind: "refused" }

interface Route {
  readonly method: "GET" | "POST" | "DELETE"
  readonly path: RegExp
  readonly require: (
    params: ReadonlyArray<string>,
    body: Readonly<Record<string, unknown>>
  ) => Requirement
}

const OPEN: Requirement = { kind: "open" }
const REFUSED: Requirement = { kind: "refused" }
const SEGMENT = "([^/]+)"
const path = (pattern: string): RegExp => new RegExp(`^${pattern.replaceAll(":id", SEGMENT)}$`)
const text = (value: unknown): string | undefined =>
  Predicate.isString(value) && value.length > 0 ? value : undefined
const ownChat = (sessionId: string | undefined): Requirement =>
  sessionId === undefined ? REFUSED : { kind: "own", target: { sessionId } }
const ownRun = (runId: string | undefined): Requirement =>
  runId === undefined ? REFUSED : { kind: "own", target: { runId } }
const declineOnly = (body: Readonly<Record<string, unknown>>): Requirement =>
  body["approved"] === true ? REFUSED : ownRun(text(body["run_id"]))

const COMMAND_LINE_ROUTES: ReadonlyArray<Route> = [
  { method: "GET", path: path("/health"), require: () => OPEN },
  { method: "GET", path: path("/spaces"), require: () => OPEN },
  { method: "GET", path: path("/sessions"), require: () => OPEN },
  {
    method: "POST",
    path: path("/sessions"),
    require: (_, body) =>
      (body["space_id"] === undefined || body["space_id"] === null) && body["origin"] === undefined
        ? OPEN
        : REFUSED
  },
  { method: "POST", path: path("/sessions/:id/branch"), require: ([id]) => ownChat(id) },
  { method: "DELETE", path: path("/sessions/:id"), require: ([id]) => ownChat(id) },
  { method: "DELETE", path: path("/sessions/:id/permanent"), require: ([id]) => ownChat(id) },
  {
    method: "POST",
    path: path("/chat/message"),
    require: (_, body) => ownChat(text(body["session_id"]))
  },
  { method: "GET", path: path("/chat/events/:id"), require: ([id]) => ownChat(id) },
  { method: "GET", path: path("/chat/runs/:id"), require: ([id]) => ownRun(id) },
  { method: "GET", path: path("/chat/runs/:id/events"), require: ([id]) => ownRun(id) },
  { method: "POST", path: path("/tools/result"), require: (_, body) => declineOnly(body) },
  { method: "POST", path: path("/connections/result"), require: (_, body) => declineOnly(body) },
  {
    method: "POST",
    path: path("/cancel"),
    require: (_, body) => {
      const runId = text(body["run_id"])
      return runId === undefined ? ownChat(text(body["session_id"])) : ownRun(runId)
    }
  }
]

const commandLineRequirement = (
  method: string,
  pathname: string,
  body: Readonly<Record<string, unknown>>
): Requirement => {
  for (const route of COMMAND_LINE_ROUTES) {
    if (route.method !== method) continue
    const match = route.path.exec(pathname)
    if (match === null) continue
    const params = match.slice(1).map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return ""
      }
    })
    return route.require(params, body)
  }
  return REFUSED
}

const jsonBody = (source: string): Readonly<Record<string, unknown>> => {
  if (source.trim() === "") return {}
  try {
    const value: unknown = JSON.parse(source)
    return Predicate.isObject(value) && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

export const commandLineAccess = HttpRouter.middleware(
  Effect.gen(function* () {
    const sessions = yield* SessionStore
    const forbidden = HttpServerResponse.empty({ status: 403 })
    return Effect.fn("CommandLineAccess")(function* <E, R>(
      httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
    ) {
      if ((yield* LocalCaller) !== "cli") return yield* httpApp
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://localhost")
      const body =
        request.method === "POST"
          ? jsonBody(yield* request.text.pipe(Effect.orElseSucceed(() => "")))
          : {}
      const requirement = commandLineRequirement(request.method, url.pathname, body)
      switch (requirement.kind) {
        case "open":
          return yield* httpApp
        case "refused":
          return forbidden
        case "own": {
          const own = yield* sessions
            .commandLineChat(requirement.target)
            .pipe(Effect.orElseSucceed(() => false))
          return own ? yield* httpApp : forbidden
        }
      }
    })
  }),
  { global: true }
)
