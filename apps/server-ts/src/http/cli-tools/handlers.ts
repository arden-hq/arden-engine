import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"

import { CliTools } from "../../cli-tools/service.js"
import { ArdenApi } from "../api.js"

const readError = (): HttpApiError.InternalServerError => new HttpApiError.InternalServerError({})

export const CliToolHandlers = HttpApiBuilder.group(
  ArdenApi,
  "cliTools",
  Effect.fn("CliToolHandlers")(function* (handlers) {
    const tools = yield* CliTools
    return handlers
      .handle("list", () => tools.current().pipe(Effect.mapError(readError)))
      .handle("refresh", () => tools.refresh().pipe(Effect.mapError(readError)))
  })
)
