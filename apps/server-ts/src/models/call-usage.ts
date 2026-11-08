import type { CompletionResponse } from "@arden-hq/loop"
import { Effect } from "effect"
import type { ModelCallUsage, UsageStore, UsageTokens } from "../persistence/usage/store.js"

const addResponse = (
  tally: UsageTokens | undefined,
  usage: CompletionResponse["usage"]
): UsageTokens => {
  const prompt = (tally?.prompt ?? 0) + (usage.prompt_tokens ?? 0)
  const completion = (tally?.completion ?? 0) + usage.completion_tokens
  const cache_read = (tally?.cache_read ?? 0) + (usage.cache_read_tokens ?? 0)
  const cache_write = (tally?.cache_write ?? 0) + (usage.cache_write_tokens ?? 0)
  return {
    prompt,
    completion,
    cache_read,
    cache_write,
    total: prompt + completion + cache_read + cache_write
  }
}

export const meteredModelCall = <A, E, R>(
  usage: UsageStore["Service"],
  call: ModelCallUsage & { readonly modelId: string },
  run: (onResponse: (response: Pick<CompletionResponse, "usage">) => void) => Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    let tally: UsageTokens | undefined
    const record = Effect.suspend(() =>
      tally === undefined
        ? Effect.void
        : usage
            .recordModelCall({ ...call, usage: tally })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not record model-call usage", { kind: call.kind, cause })
              )
            )
    )
    return run((response) => {
      tally = addResponse(tally, response.usage)
    }).pipe(Effect.ensuring(record))
  })
