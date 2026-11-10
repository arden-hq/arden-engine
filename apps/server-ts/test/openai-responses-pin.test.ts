import type { CompletionResponse, ModelProviderRequest, ModelStreamItem } from "@arden-hq/loop"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import {
  makeOpenAiResponsesProvider,
  OpenAiResponsesProviderError
} from "../src/providers/openai-responses/index.js"

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

const servers: Array<ReturnType<typeof createServer>> = []

const listen = async (handler: Handler): Promise<string> => {
  const server = createServer((request, response) => {
    void handler(request, response)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("test server did not bind")
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

const sse = (response: ServerResponse, data: unknown): void => {
  response.write(`data: ${JSON.stringify(data)}\n\n`)
}

const sseHead = (response: ServerResponse): void => {
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.flushHeaders()
}

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const parts: Array<Buffer> = []
  for await (const part of request) parts.push(Buffer.from(part))
  return JSON.parse(Buffer.concat(parts).toString("utf8"))
}

const withoutReadyItems = <T extends { readonly _tag: string }>(items: ReadonlyArray<T>) =>
  items.filter((item) => item._tag !== "OutputItemReady")

const collect = async (
  iterable: Iterable<ModelStreamItem> | AsyncIterable<ModelStreamItem>
): Promise<Array<ModelStreamItem>> => {
  const items: Array<ModelStreamItem> = []
  for await (const item of iterable) items.push(item)
  return items
}

const baseRequest: ModelProviderRequest = {
  model: "gpt-5.4",
  messages: [{ role: "user", content: "Hi." }],
  renderInteraction: (interaction) => interaction.content,
  tools: [],
  deferredTools: [],
  toolChoice: "auto"
}

const terminalWithoutIds = {
  id: "resp-1",
  output: [
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Thinking." }]
    },
    {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Done." }]
    },
    {
      type: "reasoning",
      id: "rs-real",
      encrypted_content: "enc-real",
      summary: [{ type: "summary_text", text: "Real." }],
      status: "completed"
    },
    {
      id: "msg-real",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: " Kept." }],
      status: "completed"
    }
  ],
  usage: {
    input_tokens: 40,
    input_tokens_details: { cached_tokens: 15 },
    output_tokens: 7
  }
} as const

const simpleCompleted = {
  id: "resp-simple",
  output: [
    {
      id: "msg-1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Recovered." }],
      status: "completed"
    }
  ],
  usage: { input_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2 }
} as const

const staticCredentials = { get: async () => ({ accessToken: "token-1" }) }

describe("OpenAI Responses provider pin (I-107 Risk #4)", () => {
  it("retries a pre-emission 401 exactly once with forceRefresh, then fails closed", async () => {
    let attempts = 0
    const baseUrl = await listen((_request, response) => {
      attempts += 1
      response.writeHead(401, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "expired" } }))
    })

    const credentialCalls: Array<boolean> = []
    const provider = makeOpenAiResponsesProvider({
      baseUrl,
      credentials: {
        get: async ({ forceRefresh }) => {
          credentialCalls.push(forceRefresh ?? false)
          return { accessToken: `token-${credentialCalls.length}` }
        }
      }
    })

    await expect(collect(await provider.stream(baseRequest))).rejects.toThrow(
      "OpenAI request failed with status 401"
    )
    expect(attempts).toBe(2)
    expect(credentialCalls).toEqual([false, true])
  })

  it("retries a post-emission transport failure, yielding ProviderStreamRetry with attempt/delay before re-streaming", async () => {
    let attempts = 0
    const baseUrl = await listen((_request, response) => {
      attempts += 1
      sseHead(response)
      if (attempts === 1) {
        response.write("retry: 5\n\n")
        sse(response, { type: "response.output_text.delta", output_index: 0, delta: "Partial" })
        setTimeout(() => response.socket?.destroy(), 5)
        return
      }
      sse(response, { type: "response.completed", response: simpleCompleted })
      response.end()
    })

    const provider = makeOpenAiResponsesProvider({ baseUrl, credentials: staticCredentials })
    const items = withoutReadyItems(await collect(await provider.stream(baseRequest)))

    expect(attempts).toBe(2)
    expect(items[0]).toEqual({ _tag: "TextDelta", content: "Partial" })
    expect(items[1]).toEqual({
      _tag: "ProviderStreamRetry",
      attempt: 1,
      maxAttempts: 5,
      delayMs: 5,
      reason: expect.any(String)
    })
    expect((items.at(-1) as CompletionResponse).message.content).toBe("Recovered.")
  })

  it("waits as the response's retry headers say before the retry", async () => {
    let attempts = 0
    const baseUrl = await listen((_request, response) => {
      attempts += 1
      if (attempts === 1) {
        response.writeHead(429, { "retry-after-ms": "20", "retry-after": "9" })
        response.end()
        return
      }
      sseHead(response)
      sse(response, { type: "response.completed", response: simpleCompleted })
      response.end()
    })

    const provider = makeOpenAiResponsesProvider({ baseUrl, credentials: staticCredentials })
    const items = withoutReadyItems(await collect(await provider.stream(baseRequest)))

    expect(attempts).toBe(2)
    expect(items[0]).toEqual({
      _tag: "ProviderStreamRetry",
      attempt: 1,
      maxAttempts: 5,
      delayMs: 20,
      reason: expect.any(String)
    })
    expect(items).toHaveLength(2)
  })

  it("treats SSE idleness as a transport retry (injected short timeout in place of the 120s default)", async () => {
    let attempts = 0
    const baseUrl = await listen((_request, response) => {
      attempts += 1
      sseHead(response)
      if (attempts === 1) {
        response.write("retry: 5\n\n")
        sse(response, { type: "response.output_text.delta", output_index: 0, delta: "Stall" })
        return
      }
      sse(response, { type: "response.completed", response: simpleCompleted })
      response.end()
    })

    const provider = makeOpenAiResponsesProvider({
      baseUrl,
      idleTimeoutMs: 50,
      credentials: staticCredentials
    })
    const started = Date.now()
    const items = withoutReadyItems(await collect(await provider.stream(baseRequest)))

    expect(attempts).toBe(2)
    expect(Date.now() - started).toBeGreaterThanOrEqual(50)
    expect(items.slice(0, 2)).toEqual([
      { _tag: "TextDelta", content: "Stall" },
      {
        _tag: "ProviderStreamRetry",
        attempt: 1,
        maxAttempts: 5,
        delayMs: 5,
        reason: "OpenAI response stream became idle"
      }
    ])
    expect((items.at(-1) as CompletionResponse).message.content).toBe("Recovered.")
  })

  it("retries transient statuses, then stops immediately on a non-retryable 400", async () => {
    let attempts = 0
    const baseUrl = await listen((_request, response) => {
      attempts += 1
      if (attempts <= 2) {
        response.writeHead(attempts === 1 ? 500 : 503, { "retry-after-ms": "1" })
        response.end()
        return
      }
      response.writeHead(400, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "bad request" } }))
    })

    const provider = makeOpenAiResponsesProvider({ baseUrl, credentials: staticCredentials })
    await expect(collect(await provider.stream(baseRequest))).rejects.toThrow(
      "OpenAI request failed with status 400"
    )

    expect(attempts).toBe(3)
  })

  it("rejects a non-positive or fractional idle timeout at construction", () => {
    for (const idleTimeoutMs of [0, -1, 1.5]) {
      expect(() =>
        makeOpenAiResponsesProvider({
          baseUrl: "http://127.0.0.1:1",
          idleTimeoutMs,
          credentials: staticCredentials
        })
      ).toThrow(OpenAiResponsesProviderError)
    }
  })

  it("round-trips response items through provider_state: synthetic ids filtered, reasoning replayed without status", async () => {
    const bodies: Array<unknown> = []
    let attempts = 0
    const baseUrl = await listen(async (request, response) => {
      bodies.push(await readJson(request))
      attempts += 1
      sseHead(response)
      sse(response, {
        type: "response.completed",
        response: attempts === 1 ? terminalWithoutIds : simpleCompleted
      })
      response.end()
    })

    const provider = makeOpenAiResponsesProvider({ baseUrl, credentials: staticCredentials })
    const first = await collect(await provider.stream(baseRequest))
    const completed = first.find((item) => item._tag === "Completed")
    expect(completed?.usage).toEqual({
      prompt_tokens: 25,
      completion_tokens: 7,
      cache_read_tokens: 15,
      cache_write_tokens: 0
    })
    const stored = completed?.message.provider_state?.["openai-responses"]

    expect(stored).toEqual([
      {
        type: "reasoning",
        id: "arden-synthetic-output-0",
        summary: [{ type: "summary_text", text: "Thinking." }],
        status: "completed"
      },
      {
        id: "arden-synthetic-output-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done.", annotations: [], logprobs: [] }],
        status: "completed",
        phase: "final_answer"
      },
      {
        type: "reasoning",
        id: "rs-real",
        encrypted_content: "enc-real",
        summary: [{ type: "summary_text", text: "Real." }],
        status: "completed"
      },
      {
        id: "msg-real",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: " Kept.", annotations: [], logprobs: [] }],
        status: "completed"
      }
    ])

    await collect(
      await provider.stream({
        ...baseRequest,
        messages: [
          { role: "user", content: "Hi." },
          {
            role: "assistant",
            content: "Done. Kept.",
            ...(stored === undefined ? {} : { provider_state: { "openai-responses": stored } })
          },
          { role: "user", content: "More." }
        ]
      })
    )

    const replayed = (bodies[1] as { input: ReadonlyArray<unknown> }).input
    expect(replayed).toEqual([
      { role: "user", content: "Hi." },
      { role: "assistant", content: "Done.", phase: "final_answer" },
      {
        type: "reasoning",
        id: "rs-real",
        encrypted_content: "enc-real",
        summary: [{ type: "summary_text", text: "Real." }]
      },
      {
        id: "msg-real",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: " Kept.", annotations: [], logprobs: [] }],
        status: "completed"
      },
      { role: "user", content: "More." }
    ])
  })

  it("never declares deferred tools; the model finds them through search", async () => {
    const bodies: Array<unknown> = []
    const baseUrl = await listen(async (request, response) => {
      bodies.push(await readJson(request))
      sseHead(response)
      sse(response, { type: "response.completed", response: simpleCompleted })
      response.end()
    })
    const provider = makeOpenAiResponsesProvider({ baseUrl, credentials: staticCredentials })

    await collect(
      await provider.stream({
        ...baseRequest,
        tools: [{ name: "now", description: "", parameters: {} }],
        deferredTools: [{ name: "later", description: "", parameters: {} }]
      })
    )

    expect(bodies).toMatchObject([
      { tools: [{ type: "function", name: "now", description: "", parameters: {}, strict: false }] }
    ])
  })

  it("aborts mid-stream via req.signal without retrying", async () => {
    let attempts = 0
    let closed: (() => void) | undefined
    const connectionClosed = new Promise<void>((resolve) => {
      closed = resolve
    })
    const baseUrl = await listen((_request, response) => {
      attempts += 1
      sseHead(response)
      response.on("close", () => closed?.())
      sse(response, { type: "response.output_text.delta", output_index: 0, delta: "Part" })
    })

    const provider = makeOpenAiResponsesProvider({ baseUrl, credentials: staticCredentials })
    const controller = new AbortController()
    const stream = await provider.stream({ ...baseRequest, signal: controller.signal })
    if (!(Symbol.asyncIterator in stream)) throw new Error("expected a live Responses stream")
    const iterator = stream[Symbol.asyncIterator]()

    expect((await iterator.next()).value).toEqual({ _tag: "TextDelta", content: "Part" })
    controller.abort(new Error("user cancelled"))
    await expect(iterator.next()).rejects.toThrow("user cancelled")
    await connectionClosed
    expect(attempts).toBe(1)
  })
})
