import type { ImageInputLimits } from "@arden-hq/loop"
import { RetryableProviderError } from "@arden-hq/loop/provider-kit"
import { Effect, Schema, Semaphore } from "effect"
import { Worker } from "node:worker_threads"
import { toError } from "@arden-hq/std/errors"

import { PromptImageReply } from "./prompt-image-worker-protocol.js"

export type PromptPngResize = (input: {
  readonly data: string
  readonly limits: ImageInputLimits
  readonly signal?: AbortSignal | undefined
}) => Promise<typeof PromptImageReply.Type>

const workers = Semaphore.makeUnsafe(2)
let admitted = 0

export const resizePromptPng: PromptPngResize = async (input) => {
  input.signal?.throwIfAborted()
  if (admitted >= 18)
    throw new RetryableProviderError(
      "Arden is busy preparing images. Please retry shortly.",
      "provider_error"
    )
  admitted += 1
  try {
    return await Effect.runPromise(
      workers.withPermit(
        Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* Effect.acquireRelease(
              Effect.try({
                try: () =>
                  new Worker(new URL("./prompt-image-worker.js", import.meta.url), {
                    workerData: { data: input.data, limits: input.limits }
                  }),
                catch: toError
              }),
              (worker) => Effect.promise(() => worker.terminate()).pipe(Effect.asVoid)
            )
            return yield* Effect.tryPromise({
              try: (signal) =>
                new Promise<typeof PromptImageReply.Type>((resolve, reject) => {
                  const abort = () => reject(signal.reason)
                  signal.addEventListener("abort", abort, { once: true })
                  const cleanup = () => signal.removeEventListener("abort", abort)
                  worker.once("message", (reply: unknown) => {
                    cleanup()
                    try {
                      resolve(Schema.decodeUnknownSync(PromptImageReply)(reply))
                    } catch (cause) {
                      reject(toError(cause))
                    }
                  })
                  worker.once("error", (error) => {
                    cleanup()
                    reject(error)
                  })
                  worker.once("exit", (code) => {
                    cleanup()
                    reject(new Error(`Image worker exited before replying (${code})`))
                  })
                }),
              catch: toError
            })
          })
        )
      ),
      { signal: input.signal }
    )
  } finally {
    admitted -= 1
  }
}
