import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { ComputerService } from "../../computer/service.js"
import { ArdenApi } from "../api.js"

export const ComputerHandlers = HttpApiBuilder.group(
  ArdenApi,
  "computer",
  Effect.fn("ComputerHandlers")(function* (handlers) {
    const computer = yield* ComputerService
    const change = (operation: () => Promise<void>) =>
      Effect.tryPromise({
        try: operation,
        catch: () => new HttpApiError.InternalServerError({})
      }).pipe(Effect.map(() => computer.control.status()))
    return handlers
      .handle("setup", () => Effect.sync(computer.setupStatus))
      .handle("install", () =>
        Effect.tryPromise({
          try: () => computer.setup.start().then(computer.setupStatus),
          catch: () => new HttpApiError.InternalServerError({})
        })
      )
      .handle("stopInstall", () =>
        Effect.tryPromise({
          try: () => computer.setup.stop().then(computer.setupStatus),
          catch: () => new HttpApiError.InternalServerError({})
        })
      )
      .handle("permissions", () =>
        Effect.sync(() => {
          computer.permissions()
          return computer.setupStatus()
        })
      )
      .handle("preview", () => Effect.sync(() => computer.control.preview()))
      .handle("status", () => Effect.sync(() => computer.control.status()))
      .handle("pause", () => change(computer.pause))
      .handle("resume", () => change(computer.resume))
  })
)
