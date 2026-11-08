import type { CompletionResponse, ModelProvider, ModelRequestMiddleware } from "@arden-hq/loop"
import type { ModelPhaseTiming } from "@arden-hq/protocol/daemon"
import { randomUUID } from "node:crypto"

interface MeterInput {
  readonly admit: (sampleId: string) => Promise<void>
  readonly signal: AbortSignal
  readonly report: (timing: ModelPhaseTiming) => void
}

interface ModelRequestMeter {
  readonly middleware: ModelRequestMiddleware
  readonly stream: (stream: ModelProvider["stream"]) => ModelProvider["stream"]
  readonly sampleId: () => string
  readonly measure: <A>(
    phase: Exclude<ModelPhaseTiming["phase"], "provider">,
    operation: () => A | PromiseLike<A>
  ) => Promise<A>
}

export const responseUsage = (response: CompletionResponse) => {
  const prompt = response.usage.prompt_tokens ?? 0
  const completion = response.usage.completion_tokens ?? 0
  const cache_read = response.usage.cache_read_tokens ?? 0
  const cache_write = response.usage.cache_write_tokens ?? 0
  return {
    prompt,
    completion,
    cache_read,
    cache_write,
    total: prompt + completion + cache_read + cache_write
  }
}

export const makeModelRequestMeter = (input: MeterInput): ModelRequestMeter => {
  const clock = () => performance.now()
  let current: string | undefined
  let reserved = false
  const sampleId = (): string => {
    if (current === undefined) throw new Error("Model response has no admitted request")
    return current
  }
  const report = (timing: ModelPhaseTiming): void => {
    try {
      input.report(timing)
    } catch {}
  }
  const measure: ModelRequestMeter["measure"] = async (phase, operation) => {
    const id = sampleId()
    const start = clock()
    let completed = false
    try {
      const value = await operation()
      completed = true
      return value
    } finally {
      let outcome: ModelPhaseTiming["outcome"] = "failed"
      if (completed) outcome = "completed"
      else if (input.signal.aborted) outcome = "cancelled"
      report({
        sampleId: id,
        phase,
        outcome,
        durationMs: Math.max(0, Math.round(clock() - start)),
        consumerMs: 0,
        firstItemMs: null,
        firstTextMs: null,
        firstToolMs: null,
        retries: 0,
        scheduledBackoffMs: 0
      })
    }
  }
  return {
    sampleId,
    measure,
    middleware: async (request, next) => {
      current = randomUUID()
      reserved = true
      await measure("admission", () => input.admit(sampleId()))
      return measure("preparation", async () => next(request))
    },
    stream: (stream) =>
      async function* (request) {
        if (!reserved) {
          current = randomUUID()
          await measure("admission", () => input.admit(sampleId()))
        }
        reserved = false
        const id = sampleId()
        const start = clock()
        let consumerMs = 0
        let firstItemMs: number | null = null
        let firstTextMs: number | null = null
        let firstToolMs: number | null = null
        let retries = 0
        let scheduledBackoffMs = 0
        let completed = false
        let failed = false
        try {
          for await (const item of await stream(request)) {
            const receivedAt = clock()
            const elapsed = Math.max(0, Math.round(receivedAt - start))
            if (item._tag === "ProviderStreamRetry") {
              retries += 1
              scheduledBackoffMs += item.delayMs ?? 0
            } else {
              firstItemMs ??= elapsed
            }
            if (item._tag === "TextDelta" && item.content.trim().length > 0) firstTextMs ??= elapsed
            if (item._tag === "ToolCallDelta" || item._tag === "ProviderToolCall") {
              firstToolMs ??= elapsed
            }
            if (item._tag === "OutputItemReady" && (item.message.tool_calls?.length ?? 0) > 0) {
              firstToolMs ??= elapsed
            }
            if (item._tag === "Completed") completed = true
            try {
              yield item
            } finally {
              consumerMs += Math.max(0, clock() - receivedAt)
            }
          }
        } catch (cause) {
          failed = true
          throw cause
        } finally {
          let outcome: ModelPhaseTiming["outcome"] = "interrupted"
          if (input.signal.aborted) outcome = "cancelled"
          else if (failed) outcome = "failed"
          else if (completed) outcome = "completed"
          report({
            sampleId: id,
            phase: "provider",
            outcome,
            durationMs: Math.max(0, Math.round(clock() - start)),
            consumerMs: Math.round(consumerMs),
            firstItemMs,
            firstTextMs,
            firstToolMs,
            retries,
            scheduledBackoffMs: Math.max(0, Math.round(scheduledBackoffMs))
          })
        }
      }
  }
}
