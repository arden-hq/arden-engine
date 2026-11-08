import { ladderDelayMs } from "@arden-hq/std/retry"
import { sleep } from "@arden-hq/std/sleep"
import type { LocalModelRuntime } from "@arden-hq/protocol/local-models"
import { Context, Effect, Fiber, Layer, Schema, Semaphore } from "effect"
import { type ChildProcess, execFile, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import path from "node:path"

import { type PresetModel, renderModelsPreset } from "./models-preset.js"
import { currentMillis } from "../runtime/clock.js"
/**
 * The one `llama-server` process that runs every installed local model.
 *
 * Router mode (llama.cpp b11541): the router has no model of
 * its own; it reads `models.ini` (one section per installed model, see
 * `models-preset.ts`) and starts one child process per model on its first
 * request, routing by the `model` field (POST) or `?model=` (GET). Arden
 * supervises only the router; a child that crashes is marked unloaded by the
 * router and reloads on the next request, and the decision model's child
 * sleeps after five idle minutes, giving its memory back.
 *
 * The router starts lazily on the first request, never on the start-up path,
 * and listens on 127.0.0.1 behind a random API key. A router that exits is
 * started again by the next request after a backoff; three fast failures in a
 * row stop it (`failed`) until the installed set changes. Closing the layer's
 * scope stops it (SIGTERM, then SIGKILL after 10 s), which ends its children.
 */

export class LlamaServerError extends Schema.TaggedError<LlamaServerError>()("LlamaServerError", {
  reason: Schema.Literals(["missing", "start", "request"]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export interface LlamaResponse {
  readonly status: number
  readonly body: unknown
  readonly generation: number
}

export class LlamaServer extends Context.Service<
  LlamaServer,
  {
    readonly runtime: () => Effect.Effect<LocalModelRuntime>
    readonly processId: () => number | undefined
    readonly request: (
      route: string,
      init: { readonly body?: unknown; readonly signal?: AbortSignal | undefined }
    ) => Effect.Effect<LlamaResponse, LlamaServerError>
    readonly restart: () => Effect.Effect<void>
  }
>()("@arden-hq/server/local-models/LlamaServer") {}

const READY_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 10_000
const FAST_FAILURE_MS = 60_000
const BACKOFF_MS = [0, 1_000, 5_000, 30_000] as const
const MAX_FAST_FAILURES = 3
const LOG_LINES = 40

interface Running {
  readonly child: ChildProcess
  readonly baseUrl: string
  readonly apiKey: string
  readonly generation: number
  readonly startedAt: number
  readonly exited: Promise<void>
}

const startError = (message: string, cause?: unknown) =>
  new LlamaServerError({ reason: "start", message, ...(cause === undefined ? {} : { cause }) })

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("No free port"))
      )
    })
  })

const isLlamaServer = (pid: number) =>
  new Promise<boolean>((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "comm="], (error, stdout) =>
      resolve(error === null && stdout.trim().endsWith("llama-server"))
    )
  })

const stopOrphan = async (pidFile: string) => {
  const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim())
  if (!Number.isInteger(pid) || pid <= 0) return
  if (await isLlamaServer(pid)) process.kill(pid, "SIGKILL")
  await rm(pidFile, { force: true })
}

const stopChild = (running: Running) =>
  Effect.promise(async () => {
    if (running.child.exitCode !== null || running.child.signalCode !== null) return
    running.child.kill("SIGTERM")
    const timer = setTimeout(() => running.child.kill("SIGKILL"), STOP_TIMEOUT_MS)
    await running.exited
    clearTimeout(timer)
  })

export const llamaServerLayer = (options: {
  readonly binary: string | undefined
  readonly root: string
  readonly models: () => Effect.Effect<ReadonlyArray<PresetModel>>
}): Layer.Layer<LlamaServer> =>
  Layer.effect(
    LlamaServer,
    Effect.gen(function* () {
      const lock = yield* Semaphore.make(1)
      const pidFile = path.join(options.root, "llama-server.pid")
      const log: Array<string> = []
      let running: Running | undefined
      let generation = 0
      let fastFailures = 0
      let failure: string | undefined

      const lastLines = () => log.slice(-8).join("\n")

      const spawnRouter = Effect.fn("LlamaServer.spawn")(function* () {
        const binary = options.binary
        if (binary === undefined) {
          return yield* new LlamaServerError({
            reason: "missing",
            message: "This build has no llama-server"
          })
        }
        yield* Effect.tryPromise({
          try: () => access(binary),
          catch: (cause) =>
            new LlamaServerError({ reason: "missing", message: `${binary} is missing`, cause })
        })
        const models = yield* options.models()
        if (models.length === 0) {
          return yield* new LlamaServerError({
            reason: "missing",
            message: "No local model is installed"
          })
        }
        const apiKey = randomBytes(24).toString("hex")
        const port = yield* Effect.tryPromise({
          try: async () => {
            await mkdir(options.root, { recursive: true })
            await stopOrphan(pidFile)
            await writeFile(path.join(options.root, "models.ini"), renderModelsPreset(models))
            await writeFile(path.join(options.root, "llama-server.key"), `${apiKey}\n`, {
              mode: 0o600
            })
            return freePort()
          },
          catch: (cause) => startError("Could not prepare the local model runtime", cause)
        })
        const child = spawn(
          binary,
          [
            "--models-preset",
            path.join(options.root, "models.ini"),
            "--models-max",
            "2",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--api-key-file",
            path.join(options.root, "llama-server.key"),
            "--no-ui",
            "--cors-origins",
            "localhost"
          ],
          { stdio: ["ignore", "ignore", "pipe"], cwd: options.root }
        )
        child.stderr?.setEncoding("utf8")
        child.stderr?.on("data", (chunk: string) => {
          log.push(...chunk.split("\n").filter((line) => line.trim() !== ""))
          log.splice(0, Math.max(0, log.length - LOG_LINES))
        })
        generation += 1
        const started: Running = {
          child,
          baseUrl: `http://127.0.0.1:${port}`,
          apiKey,
          generation,
          startedAt: currentMillis(),
          exited: new Promise((resolve) => {
            child.once("exit", () => resolve())
            child.once("error", () => resolve())
          })
        }
        void started.exited.then(() => {
          void rm(pidFile, { force: true })
          if (running !== started) return
          running = undefined
          fastFailures =
            currentMillis() - started.startedAt < FAST_FAILURE_MS ? fastFailures + 1 : 0
        })
        if (child.pid !== undefined) {
          yield* Effect.promise(() => writeFile(pidFile, String(child.pid)).catch(() => undefined))
        }
        const healthy = yield* Effect.promise(async () => {
          const deadline = currentMillis() + READY_TIMEOUT_MS
          while (currentMillis() < deadline) {
            if (child.exitCode !== null || child.signalCode !== null) return false
            const ok = await fetch(`${started.baseUrl}/health`, {
              headers: { authorization: `Bearer ${apiKey}` }
            }).then(
              (response) => response.ok,
              () => false
            )
            if (ok) return true
            await sleep(250)
          }
          return false
        })
        if (!healthy) {
          yield* stopChild(started)
          return yield* startError(`llama-server did not start\n${lastLines()}`)
        }
        return started
      })

      const scope = yield* Effect.scope
      let pending: Fiber.Fiber<Running, LlamaServerError> | undefined

      const start = Effect.gen(function* () {
        if (failure !== undefined) return yield* startError(failure)
        if (fastFailures >= MAX_FAST_FAILURES) {
          failure = `llama-server stopped after ${MAX_FAST_FAILURES} failed starts\n${lastLines()}`
          return yield* startError(failure)
        }
        yield* Effect.sleep(ladderDelayMs(BACKOFF_MS, fastFailures + 1))
        return yield* Effect.uninterruptible(
          spawnRouter().pipe(
            Effect.tap((started) => Effect.sync(() => (running = started))),
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (error.reason === "start") fastFailures += 1
              })
            )
          )
        )
      }).pipe(Effect.ensuring(Effect.sync(() => (pending = undefined))))

      const ensure: Effect.Effect<Running, LlamaServerError> = Effect.suspend(() => {
        if (running !== undefined) return Effect.succeed(running)
        return lock
          .withPermits(1)(
            Effect.suspend(() => {
              if (running !== undefined) return Effect.succeed(Effect.succeed(running))
              if (pending !== undefined) return Effect.succeed(Fiber.join(pending))
              return Effect.forkIn(start, scope).pipe(
                Effect.map((fiber) => {
                  pending = fiber
                  return Fiber.join(fiber)
                })
              )
            })
          )
          .pipe(Effect.flatten)
      })

      const call = (
        target: Running,
        route: string,
        init: Parameters<LlamaServer["Service"]["request"]>[1]
      ) =>
        Effect.tryPromise({
          try: async (signal) => {
            const response = await fetch(`${target.baseUrl}${route}`, {
              method: init.body === undefined ? "GET" : "POST",
              headers: {
                authorization: `Bearer ${target.apiKey}`,
                ...(init.body === undefined ? {} : { "content-type": "application/json" })
              },
              ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
              signal: init.signal === undefined ? signal : AbortSignal.any([signal, init.signal])
            })
            const text = await response.text()
            let body: unknown = text
            try {
              body = JSON.parse(text)
            } catch {
              // A non-JSON body (a plain error line) stays text.
            }
            return { status: response.status, body, generation: target.generation }
          },
          catch: (cause) =>
            new LlamaServerError({
              reason: "request",
              message: "The local model call failed",
              cause
            })
        })

      const request: LlamaServer["Service"]["request"] = (route, init) =>
        ensure.pipe(
          Effect.flatMap((target) =>
            call(target, route, init).pipe(
              Effect.catch((error) =>
                init.signal?.aborted === true || running === target
                  ? Effect.fail(error)
                  : ensure.pipe(Effect.flatMap((next) => call(next, route, init)))
              )
            )
          )
        )

      const stop = Effect.suspend(() => {
        const target = running
        running = undefined
        return target === undefined ? Effect.void : stopChild(target)
      })

      yield* Effect.addFinalizer(() => stop)

      return LlamaServer.of({
        processId: () => running?.child.pid,
        runtime: () =>
          Effect.sync((): LocalModelRuntime => {
            if (running !== undefined) return { state: "running" }
            if (pending !== undefined) return { state: "starting" }
            if (failure !== undefined) return { state: "failed", error: failure }
            return { state: "stopped" }
          }),
        request,
        restart: () =>
          lock.withPermits(1)(
            Effect.suspend(() =>
              pending === undefined ? Effect.void : Fiber.interrupt(pending)
            ).pipe(
              Effect.andThen(stop),
              Effect.andThen(
                Effect.sync(() => {
                  failure = undefined
                  fastFailures = 0
                })
              )
            )
          )
      })
    })
  )
