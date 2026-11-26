import { ROLE } from "@arden-hq/std/message-vocabulary"
import { describe, expect, it } from "vitest"

import { decodeMessage, makeAgent } from "../src/index.js"
import { collect, completionOf, defined, sseResponse } from "./kit.js"
import {
  GEMMA,
  LLAMA_OVERFLOW,
  answered,
  llamaChunk,
  provider,
  request
} from "./chat-completions-kit.js"

describe("Chat Completions failures", () => {
  it("retries an OpenRouter mid-stream error frame and fails a terminal one with its class", async () => {
    const frame = (code: number, message: string) => ({
      id: "gen-2",
      object: "chat.completion.chunk",
      model: "openai/gpt-6-luna",
      error: { code, message, metadata: { raw: "upstream detail" } },
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }]
    })
    const { provider: cc, transport } = provider(
      [
        () => sseResponse([llamaChunk({ content: "Par" }), frame(502, "Provider returned error")]),
        answered("Recovered."),
        () =>
          sseResponse([
            frame(
              400,
              "This endpoint's maximum context length is 8192 tokens. However, you requested about 9000 tokens."
            )
          ])
      ],
      { providerId: "openrouter" }
    )

    const items = await collect(cc.stream(request()))
    expect(items.slice(0, 2)).toEqual([
      { _tag: "TextDelta", content: "Par" },
      {
        _tag: "ProviderStreamRetry",
        attempt: 1,
        maxAttempts: 5,
        delayMs: expect.any(Number),
        reason: "openrouter stream failed (502): Provider returned error"
      }
    ])
    expect(completionOf(items).message.content).toBe("Recovered.")

    await expect(collect(cc.stream(request()))).rejects.toThrow(
      expect.objectContaining({
        name: "ChatCompletionsProviderError",
        code: "context_length_exceeded",
        message:
          "openrouter stream failed (400): This endpoint's maximum context length is 8192 tokens. However, you requested about 9000 tokens."
      })
    )
    expect(transport.requests).toHaveLength(3)
  })

  it("retries a body that ends without a finish or [DONE]", async () => {
    const { provider: cc, transport } = provider([
      () => sseResponse([llamaChunk({ content: "Partial" })]),
      answered("Whole.")
    ])
    const items = await collect(cc.stream(request()))
    expect(items[1]).toEqual({
      _tag: "ProviderStreamRetry",
      attempt: 1,
      maxAttempts: 5,
      delayMs: expect.any(Number),
      reason: "llama.cpp response stream ended before a terminal event"
    })
    expect(completionOf(items).message.content).toBe("Whole.")
    expect(transport.requests).toHaveLength(2)
  })

  it("refreshes credentials once on a 401 before anything was emitted", async () => {
    const authCalls: Array<boolean> = []
    const { provider: cc, transport } = provider(
      [
        () => new Response('{"error":{"message":"expired","code":401}}', { status: 401 }),
        answered("Ok.")
      ],
      {
        auth: {
          headers: async ({ forceRefresh }) => {
            authCalls.push(forceRefresh ?? false)
            return { authorization: `Bearer token-${authCalls.length}` }
          }
        },
        headers: { "x-title": "Arden" }
      }
    )
    expect(completionOf(await collect(cc.stream(request()))).message.content).toBe("Ok.")
    expect(authCalls).toEqual([false, true])
    expect(transport.requests.map((sent) => sent.headers.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-2"
    ])
  })

  it("refreshes credentials only once when the retry is refused too", async () => {
    const authCalls: Array<boolean> = []
    const refused = () =>
      new Response('{"error":{"message":"expired","code":401}}', { status: 401 })
    const { provider: cc } = provider([refused, refused, refused, answered("Ok.")], {
      auth: {
        headers: async ({ forceRefresh }) => {
          authCalls.push(forceRefresh ?? false)
          return { authorization: "Bearer t" }
        }
      }
    })
    await expect(collect(cc.stream(request()))).rejects.toThrow()
    expect(authCalls.filter(Boolean)).toHaveLength(1)
  })

  it("classifies llama.cpp's real overflow answer as context_length_exceeded without retrying", async () => {
    const { provider: cc, transport } = provider([
      () =>
        new Response(LLAMA_OVERFLOW, {
          status: 400,
          headers: { "content-type": "application/json" }
        })
    ])
    await expect(collect(cc.stream(request()))).rejects.toThrow(
      expect.objectContaining({
        name: "ChatCompletionsProviderError",
        code: "context_length_exceeded"
      })
    )
    expect(transport.requests).toHaveLength(1)
  })
})

it("persists the origin through a makeAgent run and decodes it back", async () => {
  const { provider: cc } = provider([answered("Hi there.")])
  const result = await makeAgent(
    { model: GEMMA },
    {
      provider: cc,
      toolset: {
        entries: () => [],
        loadedNames: () => new Set(),
        load: () => {},
        execute: () => ({ content: "", preview: "" })
      }
    }
  ).run([{ role: ROLE.user, content: "Hi." }])

  const assistant = defined(
    result.messages.find((message) => message.role === ROLE.assistant),
    "an assistant message"
  )
  expect(assistant).toEqual({
    message_id: expect.any(String),
    client_id: expect.any(String),
    role: ROLE.assistant,
    content: "Hi there.",
    output_parts: [{ type: "text", text: "Hi there." }],
    origin: { provider: "llama.cpp", api: "chat-completions", model: GEMMA, requested_model: GEMMA }
  })
  expect(decodeMessage(JSON.parse(JSON.stringify(assistant)))).toEqual(assistant)
})
