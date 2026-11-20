import { commandLineRoute, type CommandLineRule } from "@arden-hq/protocol/daemon"
import { Effect, Predicate } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

import { SessionStore } from "../../persistence/sessions/store.js"
import { LocalCaller } from "./local-only.js"

type Requirement =
  | { readonly kind: "open" }
  /** The chat, or the chat of the run, is one the command line made. */
  | {
      readonly kind: "own"
      readonly target:
        | { readonly sessionId: string }
        | { readonly runId: string }
        | { readonly questionId: string }
    }
  | { readonly kind: "refused" }

const OPEN: Requirement = { kind: "open" }
const REFUSED: Requirement = { kind: "refused" }
const text = (value: unknown): string | undefined =>
  Predicate.isString(value) && value.length > 0 ? value : undefined
const ownChat = (sessionId: string | undefined): Requirement =>
  sessionId === undefined ? REFUSED : { kind: "own", target: { sessionId } }
const ownRun = (runId: string | undefined): Requirement =>
  runId === undefined ? REFUSED : { kind: "own", target: { runId } }
const ownQuestion = (questionId: string | undefined): Requirement =>
  questionId === undefined ? REFUSED : { kind: "own", target: { questionId } }

const requirementOf = (
  rule: CommandLineRule,
  params: ReadonlyArray<string>,
  body: Readonly<Record<string, unknown>>
): Requirement => {
  const [id] = params
  switch (rule) {
    case "open":
      return OPEN
    case "plain_new_chat":
      return (body["space_id"] === undefined || body["space_id"] === null) &&
        body["origin"] === undefined
        ? OPEN
        : REFUSED
    case "own_chat_in_path":
      return ownChat(text(id))
    case "own_run_in_path":
      return ownRun(text(id))
    case "own_question_in_path":
      return ownQuestion(text(id))
    case "own_chat_in_body":
      return ownChat(text(body["session_id"]))
    case "own_run_in_body":
      return ownRun(text(body["run_id"]))
    case "own_run_or_chat_in_body": {
      const runId = text(body["run_id"])
      return runId === undefined ? ownChat(text(body["session_id"])) : ownRun(runId)
    }
  }
}

const commandLineRequirement = (
  method: string,
  pathname: string,
  body: Readonly<Record<string, unknown>>
): Requirement => {
  const match = commandLineRoute(method, pathname)
  return match === undefined ? REFUSED : requirementOf(match.route.rule, match.params, body)
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
