import type { ModelProvider } from "@arden-hq/loop"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { meteredProvider, REQUEST_LIMIT_REACHED } from "../src/serve/meter.js"

const usageItem = { usage: { prompt_tokens: 7, completion_tokens: 2, cache_read_tokens: 3 } }

const route = (): ModelProvider =>
  ({
    protocolVersion: 1,
    capabilities: async () => ({
      hostedTools: [],
      structuredOutput: "native",
      toolSearch: "client"
    }),
    stream: async function* () {
      yield usageItem
    }
  }) as unknown as ModelProvider

const drain = async (provider: ModelProvider): Promise<void> => {
  const request: Parameters<ModelProvider["stream"]>[0] = {
    messages: [{ role: "system", content: "" }],
    renderInteraction: () => "",
    model: "m",
    tools: [],
    deferredTools: [],
    toolChoice: "none",
    signal: new AbortController().signal
  }
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
