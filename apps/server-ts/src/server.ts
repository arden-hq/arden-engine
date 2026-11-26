import { Cause, Context, Effect, Exit, Schema, Scope } from "effect"
import { ChatMessage as ChatMessageService } from "./chat/message.js"
import type { StopReason } from "./chat/message-shape.js"
import type { HostedServerOptions, ModelProviderOptions, ServerOptions } from "./config/options.js"
import { ModelProviderSwitch } from "./models/provider-switch.js"
import {
  NEWER_DATA_OPERATION,
  SCHEMA_CONVERT_FAILED_OPERATION,
  StorageStartupError
} from "./persistence/service.js"
import { closeServer, openServer } from "./runtime/layers.js"
import type { LocalAccess } from "./http/middleware/local-only.js"
import { ServerLifecycle } from "./runtime/lifecycle.js"

export interface ServerHandle {
  readonly hostname: string
  readonly port: number
  readonly url: URL
  readonly fetch: (input: string | Request | URL, init?: RequestInit) => Promise<Response>
  readonly drain: (input?: {
    readonly toolSettleMs?: number
    readonly reason?: StopReason
  }) => Promise<void>
  readonly replaceProvider: (next: ModelProviderOptions) => Promise<void>
  readonly stop: (input?: {
    readonly reason?: StopReason
    readonly budgetMs?: number
  }) => Promise<void>
}

const SERVER_ERROR_CODE = {
  invalid_options: "invalid_options",
  storage_failed: "storage_failed",
  data_newer: "data_newer",
  schema_convert_failed: "schema_convert_failed",
  start_failed: "start_failed",
  provider_failed: "provider_failed",
  stop_failed: "stop_failed"
} as const

export type ServerErrorCode = (typeof SERVER_ERROR_CODE)[keyof typeof SERVER_ERROR_CODE]

const STORAGE_ERROR_CODES: ReadonlySet<ServerErrorCode> = new Set([
  SERVER_ERROR_CODE.storage_failed,
  SERVER_ERROR_CODE.data_newer,
  SERVER_ERROR_CODE.schema_convert_failed
])

export const isStorageErrorCode = (code: ServerErrorCode): boolean => STORAGE_ERROR_CODES.has(code)

export class ServerError extends Error {
  readonly code: ServerErrorCode

  constructor(message: string, code: ServerErrorCode) {
    super(message)
    this.name = "ServerError"
    this.code = code
  }
}

const startConfiguredServer = async (options: HostedServerOptions): Promise<ServerHandle> => {
  const scope = Scope.makeUnsafe("sequential")

  try {
    const opened = await Effect.runPromise(openServer(options, scope))
    const address = opened.address
    const urlHost = address.hostname.includes(":") ? `[${address.hostname}]` : address.hostname
    const url = new URL(`http://${urlHost}:${address.port}`)
    let stopping: Promise<void> | undefined
    let draining: Promise<void> | undefined
    let deadline: number | undefined
    const lifecycle = Context.get(opened.context, ServerLifecycle)
    const remaining = () => Math.max(0, (deadline ?? performance.now()) - performance.now())
    const drain = (input?: {
      readonly toolSettleMs?: number
      readonly reason?: StopReason
    }): Promise<void> => {
      deadline ??= performance.now() + 5_500
      draining ??= Effect.runPromise(
        Effect.gen(function* () {
          yield* lifecycle.quiesce
          yield* lifecycle.settled.pipe(
            Effect.timeout(Math.max(1, remaining() - 1_000)),
            Effect.catchTag("TimeoutError", () =>
              Effect.logWarning("Server maintenance exceeded the shutdown budget")
            )
          )
          const drainBudgetMs = Math.max(0, remaining() - 500)
          yield* Effect.all(
            [
              Context.get(opened.context, ChatMessageService).drain({
                toolSettleMs: Math.min(
                  input?.toolSettleMs ?? 3_000,
                  Math.max(0, remaining() - 1_000)
                ),
                budgetMs: drainBudgetMs,
                reason: input?.reason ?? "restart"
              }),
              lifecycle.acceptedSettled.pipe(
                Effect.timeout(Math.max(1, drainBudgetMs)),
                Effect.catchTag("TimeoutError", () =>
                  Effect.logWarning("Accepted server work exceeded the shutdown budget")
                )
              )
            ],
            { concurrency: "unbounded", discard: true }
          )
        })
      ).catch(async (cause) => {
        await Effect.runPromise(
          Effect.logWarning("Could not drain live Chat runs", { cause })
        ).catch(() => undefined)
      })
      return draining
    }
    const replaceProvider = (next: ModelProviderOptions): Promise<void> =>
      Effect.runPromise(
        Effect.gen(function* () {
          if (!lifecycle.isAccepting())
            return yield* Effect.fail(
              new ServerError("Arden is stopping", SERVER_ERROR_CODE.provider_failed)
            )
          yield* Context.get(opened.context, ModelProviderSwitch).replace(next)
        })
      ).catch(async (cause) => {
        if (Schema.isSchemaError(cause)) {
          throw new ServerError("Invalid provider options", SERVER_ERROR_CODE.invalid_options)
        }
        await Effect.runPromise(Effect.logError(cause)).catch(() => undefined)
        throw new ServerError(
          "Could not replace the model provider",
          SERVER_ERROR_CODE.provider_failed
        )
      })
    const stop: ServerHandle["stop"] = (input) => {
      if (
        input?.budgetMs !== undefined &&
        (!Number.isFinite(input.budgetMs) || input.budgetMs < 0)
      ) {
        return Promise.reject(
          new ServerError("Invalid shutdown budget", SERVER_ERROR_CODE.invalid_options)
        )
      }
      deadline ??= performance.now() + (input?.budgetMs ?? 5_500)
      stopping ??= (async () => {
        const started = performance.now()
        await drain({ reason: input?.reason ?? "quit" })
        const exit = await Effect.runPromiseExit(
          Effect.gen(function* () {
            yield* lifecycle.close
            yield* Effect.logInfo("Server shutdown drain ended", {
              elapsedMs: Math.round(performance.now() - started),
              remainingMs: Math.round(remaining())
            })
            yield* closeServer(opened)
            yield* lifecycle.stopped
          })
        )
        if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return
        await Effect.runPromise(Effect.logError(Cause.squash(exit.cause))).catch(() => undefined)
        throw new ServerError("Failed to stop Arden server", SERVER_ERROR_CODE.stop_failed)
      })()
      return stopping
    }

    return {
      hostname: address.hostname,
      port: address.port,
      url,
      fetch: (input, init) =>
        globalThis.fetch(typeof input === "string" ? new URL(input, url) : input, init),
      drain,
      replaceProvider,
      stop
    }
  } catch (cause) {
    await Effect.runPromise(Scope.close(scope, Exit.die(cause))).catch(() => undefined)
    if (Schema.isSchemaError(cause)) {
      throw new ServerError("Invalid server options", SERVER_ERROR_CODE.invalid_options)
    }
    await Effect.runPromise(Effect.logError(cause)).catch(() => undefined)
    if (cause instanceof StorageStartupError && cause.operation === NEWER_DATA_OPERATION) {
      throw new ServerError(cause.message, SERVER_ERROR_CODE.data_newer)
    }
    if (
      cause instanceof StorageStartupError &&
      cause.operation === SCHEMA_CONVERT_FAILED_OPERATION
    ) {
      throw new ServerError(cause.message, SERVER_ERROR_CODE.schema_convert_failed)
    }
    if (cause instanceof StorageStartupError) {
      throw new ServerError(cause.message, SERVER_ERROR_CODE.storage_failed)
    }
    throw new ServerError("Failed to start Arden server", SERVER_ERROR_CODE.start_failed)
  }
}

export const startServer = (options: ServerOptions = {}): Promise<ServerHandle> =>
  startConfiguredServer(options)

export const startServerWithLocalAccess = (
  options: HostedServerOptions & { readonly localAccess: LocalAccess }
): Promise<ServerHandle> => startConfiguredServer(options)
