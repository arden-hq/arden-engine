import { addCost, type ModelProvider } from "@arden-hq/loop"
import { writeAtomicSync } from "@arden-hq/std/atomic-file"
import { readFileSync } from "node:fs"

/** Every model request of the data folder so far, sub-agents and side jobs included. */
interface Usage {
  modelRequests: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /**
   * US dollars the providers reported for these requests (`Usage.cost`), or
   * null once any request's provider reported none (llama.cpp, Codex): a
   * total with an unknown part is never shown as the spend.
   */
  costUsd: number | null
  /** True once a request was refused because `maxModelRequests` was reached. */
  budgetExhausted: boolean
}

const empty = (): Usage => ({
  modelRequests: 0,
  promptTokens: 0,
  completionTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  budgetExhausted: false
})

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0

const dollars = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

/** The counts an earlier start left in `file`, so a restart goes on counting. */
const readUsage = (file: string): Usage => {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<Record<keyof Usage, unknown>>
    return {
      modelRequests: count(value.modelRequests),
      promptTokens: count(value.promptTokens),
      completionTokens: count(value.completionTokens),
      cacheReadTokens: count(value.cacheReadTokens),
      cacheWriteTokens: count(value.cacheWriteTokens),
      // A file from before costs were kept has none: its requests' cost is unknown.
      costUsd: dollars(value.costUsd) ?? null,
      budgetExhausted: value.budgetExhausted === true
    }
  } catch {
    return empty()
  }
}

export const REQUEST_LIMIT_REACHED = "The settings file's model-request limit is reached"

export interface MeterOptions {
  /** Where the counts are kept, rewritten after every model request. */
  readonly file: string
  /** Most model requests the data folder may make; the next one fails. */
  readonly maxModelRequests: number | undefined
  /** False declares every allowed tool up front instead of the route's tool search. */
  readonly toolSearch: boolean | undefined
}

/**
 * The provider a configured server runs on: the route's own, with every model
 * request counted into the usage file and refused past the limit. It counts
 * what the provider is asked, so sub-agents, compaction and chat names are in.
 */
export const meteredProvider = (provider: ModelProvider, options: MeterOptions): ModelProvider => {
  const usage = readUsage(options.file)
  const save = (): void => {
    writeAtomicSync(options.file, `${JSON.stringify(usage, null, 2)}\n`)
  }
  save()
  const metered = (stream: ModelProvider["stream"]): ModelProvider["stream"] =>
    async function* (request) {
      if (
        options.maxModelRequests !== undefined &&
        usage.modelRequests >= options.maxModelRequests
      ) {
        usage.budgetExhausted = true
        save()
        throw new Error(REQUEST_LIMIT_REACHED)
      }
      usage.modelRequests += 1
      try {
        for await (const item of await stream(request)) {
          if (typeof item === "object" && item !== null && "usage" in item) {
            const used = item.usage as Record<string, unknown>
            usage.promptTokens += count(used["prompt_tokens"])
            usage.completionTokens += count(used["completion_tokens"])
            usage.cacheReadTokens += count(used["cache_read_tokens"])
            usage.cacheWriteTokens += count(used["cache_write_tokens"])
            usage.costUsd = addCost(usage.costUsd ?? undefined, dollars(used["cost"])) ?? null
          }
          yield item
        }
      } finally {
        save()
      }
    }
  const { capabilities, openSession } = provider
  return {
    protocolVersion: 1,
    ...(capabilities === undefined
      ? {}
      : {
          capabilities: async (model: string) => {
            const own = await capabilities(model)
            return options.toolSearch === false ? { ...own, toolSearch: "none" as const } : own
          }
        }),
    ...(openSession === undefined
      ? {}
      : {
          openSession: async () => {
            const session = await openSession()
            return {
              stream: metered((request) => session.stream(request)),
              close: () => session.close()
            }
          }
        }),
    stream: metered((request) => provider.stream(request))
  }
}
