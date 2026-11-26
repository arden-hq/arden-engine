import { parseJsonText } from "@arden-hq/protocol/common"
import {
  addCost,
  PROVIDER_ERROR_CODE,
  providerErrorCode,
  type ModelProvider,
  type ProviderErrorCode,
  MODEL_PROVIDER_PROTOCOL
} from "@arden-hq/loop"
import { writeAtomicSync } from "@arden-hq/std/atomic-file"
import { readFileSync } from "node:fs"

interface Usage {
  modelRequests: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number | null
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

const readUsage = (file: string): Usage => {
  try {
    const value = parseJsonText(readFileSync(file, "utf8")) as Partial<Record<keyof Usage, unknown>>
    return {
      modelRequests: count(value.modelRequests),
      promptTokens: count(value.promptTokens),
      completionTokens: count(value.completionTokens),
      cacheReadTokens: count(value.cacheReadTokens),
      cacheWriteTokens: count(value.cacheWriteTokens),
      costUsd: dollars(value.costUsd) ?? null,
      budgetExhausted: value.budgetExhausted === true
    }
  } catch {
    return empty()
  }
}

export const REQUEST_LIMIT_REACHED = "The settings file's model-request limit is reached"

export interface MeterOptions {
  readonly file: string
  readonly maxModelRequests: number | undefined
  readonly toolSearch: boolean | undefined
}

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
      let accounted = false
      try {
        for await (const item of await stream(request)) {
          if (typeof item === "object" && item !== null && "usage" in item) {
            accounted = true
            const used = item.usage as Record<string, unknown>
            usage.promptTokens += count(used["prompt_tokens"])
            usage.completionTokens += count(used["completion_tokens"])
            usage.cacheReadTokens += count(used["cache_read_tokens"])
            usage.cacheWriteTokens += count(used["cache_write_tokens"])
            usage.costUsd = addCost(usage.costUsd ?? undefined, dollars(used["cost"])) ?? null
          }
          yield item
        }
      } catch (error) {
        accounted = refusedBeforeRunning(providerErrorCode(error))
        throw error
      } finally {
        if (!accounted) usage.costUsd = null
        save()
      }
    }
  const { capabilities, openSession } = provider
  return {
    protocolVersion: MODEL_PROVIDER_PROTOCOL,
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

const refusedBeforeRunning = (code: ProviderErrorCode | undefined): boolean => {
  switch (code) {
    case PROVIDER_ERROR_CODE.contextLengthExceeded:
    case PROVIDER_ERROR_CODE.rateLimited:
    case PROVIDER_ERROR_CODE.providerAuth:
    case PROVIDER_ERROR_CODE.requestInvalid:
    case PROVIDER_ERROR_CODE.modelUnavailable:
      return true
    case PROVIDER_ERROR_CODE.providerUnavailable:
    case PROVIDER_ERROR_CODE.providerError:
    case undefined:
      return false
  }
}
