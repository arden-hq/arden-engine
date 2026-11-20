import { MODEL_PROVIDER_PROTOCOL } from "@arden-hq/loop"
import { ROLE } from "@arden-hq/std/message-vocabulary"
import type { ModelProvider } from "@arden-hq/loop"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { meteredProvider, REQUEST_LIMIT_REACHED } from "../src/serve/meter.js"

const usageItem = { usage: { prompt_tokens: 7, completion_tokens: 2, cache_read_tokens: 3 } }

const route = (): ModelProvider =>
  ({
    protocolVersion: MODEL_PROVIDER_PROTOCOL,
    capabilities: async () => ({
      hostedTools: [],
      structuredOutput: "native",
      toolSearch: "client"
    }),
    stream: async function* () {
      yield usageItem
    }
  }) as unknown as ModelProvider

const request: Parameters<ModelProvider["stream"]>[0] = {
  messages: [{ role: ROLE.system, content: "" }],
  renderInteraction: () => "",
  model: "m",
  tools: [],
  deferredTools: [],
  toolChoice: "none",
  signal: new AbortController().signal
}

const drain = async (provider: ModelProvider): Promise<void> => {
  for await (const _ of await provider.stream(request)) void _
}

it("counts every model request into the usage file and refuses past the limit, across restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "arden-meter-"))
  const file = join(root, "usage.json")
  const read = async (): Promise<unknown> => JSON.parse(await readFile(file, "utf8"))
  try {
    const first = meteredProvider(route(), { file, maxModelRequests: 2, toolSearch: false })
    expect(await read()).toMatchObject({ modelRequests: 0, budgetExhausted: false })
    await drain(first)
    expect(await read()).toEqual({
      modelRequests: 1,
      promptTokens: 7,
      completionTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
      costUsd: null,
      budgetExhausted: false
    })
    // A second start on the same folder goes on counting.
    const second = meteredProvider(route(), { file, maxModelRequests: 2, toolSearch: undefined })
    await drain(second)
    await expect(drain(second)).rejects.toThrow(REQUEST_LIMIT_REACHED)
    expect(await read()).toMatchObject({
      modelRequests: 2,
      promptTokens: 14,
      budgetExhausted: true
    })
    // Tool search is turned off only when the settings say so.
    expect((await first.capabilities?.("m"))?.toolSearch).toBe("none")
    expect((await second.capabilities?.("m"))?.toolSearch).toBe("client")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("sums the cost providers report into the usage file, and says null once a request reported none", async () => {
  const root = await mkdtemp(join(tmpdir(), "arden-meter-"))
  const file = join(root, "usage.json")
  const read = async (): Promise<unknown> => JSON.parse(await readFile(file, "utf8"))
  const costing = (costs: ReadonlyArray<number | undefined>): ModelProvider => {
    let next = 0
    return {
      ...route(),
      stream: async function* () {
        const cost = costs[next]
        next += 1
        yield { usage: { ...usageItem.usage, ...(cost === undefined ? {} : { cost }) } }
      }
    } as unknown as ModelProvider
  }
  try {
    const priced = meteredProvider(costing([0.0004, 0.0001]), {
      file,
      maxModelRequests: undefined,
      toolSearch: undefined
    })
    expect(await read()).toMatchObject({ costUsd: 0 })
    await drain(priced)
    await drain(priced)
    expect(await read()).toMatchObject({ modelRequests: 2, costUsd: 0.0004 + 0.0001 })
    // A restart goes on summing; one request without a cost makes the total unknown for good.
    const mixed = meteredProvider(costing([0.0002, undefined, 0.0003]), {
      file,
      maxModelRequests: undefined,
      toolSearch: undefined
    })
    await drain(mixed)
    expect(await read()).toMatchObject({ modelRequests: 3, costUsd: 0.0004 + 0.0001 + 0.0002 })
    await drain(mixed)
    await drain(mixed)
    expect(await read()).toMatchObject({ modelRequests: 5, costUsd: null })
    const restarted = meteredProvider(costing([0.0001]), {
      file,
      maxModelRequests: undefined,
      toolSearch: undefined
    })
    await drain(restarted)
    expect(await read()).toMatchObject({ modelRequests: 6, costUsd: null })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("makes the cost unknown when a request ends before its usage arrives, unless the provider refused it", async () => {
  const root = await mkdtemp(join(tmpdir(), "arden-meter-"))
  const file = join(root, "usage.json")
  const read = async (): Promise<unknown> => JSON.parse(await readFile(file, "utf8"))
  const options = { file, maxModelRequests: undefined, toolSearch: undefined }
  const failing = (error: Error): ModelProvider =>
    meteredProvider(
      {
        ...route(),
        stream: async function* () {
          yield { _tag: "TextDelta", content: "Na" }
          throw error
        }
      } as unknown as ModelProvider,
      options
    )
  try {
    // A refusal is answered before the model runs, so it costs nothing.
    const refusal = Object.assign(new Error("prompt is too long"), {
      code: "context_length_exceeded"
    })
    await expect(drain(failing(refusal))).rejects.toThrow("prompt is too long")
    expect(await read()).toMatchObject({ modelRequests: 1, costUsd: 0 })
    // The connection fails before the usage chunk.
    await expect(drain(failing(new Error("connection reset")))).rejects.toThrow("connection reset")
    expect(await read()).toMatchObject({ modelRequests: 2, costUsd: null })
    await rm(file)
    // The consumer stops reading first, as a server stopping under a side job does.
    const stopped = meteredProvider(
      {
        ...route(),
        stream: async function* () {
          yield { _tag: "TextDelta", content: "Na" }
          yield { usage: { ...usageItem.usage, cost: 0.0004 } }
        }
      } as unknown as ModelProvider,
      options
    )
    for await (const _ of await stopped.stream(request)) break
    expect(await read()).toMatchObject({ modelRequests: 1, costUsd: null })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
