import { describe, expect, it } from "vitest"

import { renderInteraction } from "../src/agent/interactions.js"
import type { AssistantMessage, ChatMessage } from "../src/contracts/messages.js"
import type { ModelProviderRequest } from "../src/contracts/provider.js"
import { decodeMessage, makeAgent } from "../src/index.js"
import {
  makeChatCompletionsProvider,
  type ChatCompletionsProviderOptions
} from "../src/providers/chat-completions/provider.js"
import { MISSING_TOOL_OUTPUT } from "../src/providers/kit/index.js"
import { makeOpenAiResponsesProvider } from "../src/providers/openai-responses/provider.js"
import { makeToolSearch } from "../src/tools/search.js"
import { collect, completionOf, defined, recordOf, scriptedFetch, sseResponse } from "./kit.js"

const GEMMA = "ggml-org/gemma-4-E2B-it-GGUF:Q8_0"

/** A llama.cpp `llama-server` chunk, as captured from the live server (b12359). */
const llamaChunk = (delta: unknown, finish: string | null = null) => ({
  choices: [{ finish_reason: finish, index: 0, delta }],
  created: 1794771364,
  id: "chatcmpl-9Z4BdzrNvdRIaavSuacSnnIcNy1FUYZ7",
  model: GEMMA,
  system_fingerprint: "b12359-b1b770d90",
  object: "chat.completion.chunk"
})

const llamaUsage = {
  choices: [],
  created: 1794771367,
  id: "chatcmpl-9Z4BdzrNvdRIaavSuacSnnIcNy1FUYZ7",
  model: GEMMA,
  system_fingerprint: "b12359-b1b770d90",
  object: "chat.completion.chunk",
  usage: {
    completion_tokens: 199,
    prompt_tokens: 76,
    total_tokens: 275,
    prompt_tokens_details: { cached_tokens: 71 }
  },
  timings: { cache_n: 71, prompt_n: 5, predicted_n: 199 }
}

/** The body llama.cpp answered an over-long prompt with (live, 2026-11-15, n_ctx 4096). */
const LLAMA_OVERFLOW =
  '{"error":{"code":400,"message":"request (6016 tokens) exceeds the available context size (4096 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":6016,"n_ctx":4096}}'

const answered = (text: string) => () =>
  sseResponse([llamaChunk({ content: text }), llamaChunk({}, "stop"), llamaUsage, "[DONE]"])

const weather = {
  name: "weather",
  description: "Weather for one city.",
  parameters: { type: "object" }
}

const call = (id: string, city = "Paris") => ({
  id,
  type: "function" as const,
  function: { name: "weather", arguments: JSON.stringify({ city }) }
})

const request = (overrides: Partial<ModelProviderRequest> = {}): ModelProviderRequest => ({
  model: GEMMA,
  messages: [{ role: "user", content: "Hi." }],
  renderInteraction,
  tools: [],
  deferredTools: [],
  toolChoice: "auto",
  ...overrides
})

const provider = (
  answers: ReadonlyArray<() => Response>,
  options: Partial<ChatCompletionsProviderOptions> = {}
) => {
  const transport = scriptedFetch(answers)
  return {
    transport,
    provider: makeChatCompletionsProvider({
      providerId: "llama.cpp",
      baseUrl: "http://127.0.0.1:9931/v1/",
      fetch: transport.fetch,
      ...options
    })
  }
}

const sentMessages = (body: unknown) => recordOf(body).messages

describe("Chat Completions stream mapping", () => {
  it("maps llama.cpp reasoning, text, two parallel calls and cached usage", async () => {
    const { provider: cc, transport } = provider([
      () =>
        sseResponse([
          llamaChunk({ role: "assistant", content: null }),
          llamaChunk({ reasoning_content: "Two " }),
          llamaChunk({ reasoning_content: "cities." }),
          llamaChunk({ content: "Checking both." }),
          llamaChunk({
            tool_calls: [
              {
                index: 0,
                id: "Z7zb",
                type: "function",
                function: { name: "weather", arguments: "{" }
              }
            ]
          }),
          llamaChunk({ tool_calls: [{ index: 0, function: { arguments: '"city":"Paris"}' } }] }),
          llamaChunk({
            tool_calls: [
              {
                index: 1,
                id: "gQg6",
                type: "function",
                function: { name: "weather", arguments: "{" }
              }
            ]
          }),
          llamaChunk({ tool_calls: [{ index: 1, function: { arguments: '"city":"Rome"}' } }] }),
          llamaChunk({}, "tool_calls"),
          llamaUsage,
          "[DONE]"
        ])
    ])

    const items = await collect(cc.stream(request()))

    expect(transport.requests.map((sent) => sent.url)).toEqual([
      "http://127.0.0.1:9931/v1/chat/completions"
    ])
    expect(items).toEqual([
      { _tag: "ReasoningDelta", content: "Two " },
      { _tag: "ReasoningDelta", content: "cities." },
      { _tag: "TextDelta", content: "Checking both." },
      {
        _tag: "ToolCallDelta",
        index: 0,
        tool_id: "Z7zb",
        name: "weather",
        arguments_delta: "{",
        done: false
      },
      { _tag: "ToolCallDelta", index: 0, arguments_delta: '"city":"Paris"}', done: false },
      {
        _tag: "ToolCallDelta",
        index: 1,
        tool_id: "gQg6",
        name: "weather",
        arguments_delta: "{",
        done: false
      },
      { _tag: "ToolCallDelta", index: 1, arguments_delta: '"city":"Rome"}', done: false },
      { _tag: "ToolCallDelta", index: 0, arguments_delta: null, done: true },
      { _tag: "ToolCallDelta", index: 1, arguments_delta: null, done: true },
      {
        _tag: "Completed",
        message: {
          role: "assistant",
          content: "Checking both.",
          tool_calls: [call("Z7zb"), call("gQg6", "Rome")],
          reasoning_content: "Two cities.",
          output_parts: [
            { type: "reasoning", text: "Two cities." },
            { type: "text", text: "Checking both." },
            { type: "tool_call", tool_call_id: "Z7zb", execution: "runtime" },
            { type: "tool_call", tool_call_id: "gQg6", execution: "runtime" }
          ],
          origin: { provider: "llama.cpp", api: "chat-completions", model: GEMMA }
        },
        finish_reason: "tool_calls",
        usage: {
          prompt_tokens: 5,
          completion_tokens: 199,
          cache_read_tokens: 71,
          cache_write_tokens: 0
        },
        model: GEMMA
      }
    ])
  })

  it("keeps only complete calls when the output limit cuts one off", async () => {
    const { provider: cc } = provider([
      () =>
        sseResponse([
          llamaChunk({
            tool_calls: [
              {
                index: 0,
                id: "whole",
                function: { name: "weather", arguments: '{"city":"Paris"}' }
              }
            ]
          }),
          llamaChunk({
            tool_calls: [{ index: 1, id: "cut", function: { name: "weather", arguments: '{"ci' } }]
          }),
          llamaChunk({}, "length"),
          "[DONE]"
        ])
    ])

    const items = await collect(cc.stream(request()))

    expect(items.slice(2)).toEqual([
      { _tag: "ToolCallDelta", index: 0, arguments_delta: null, done: true },
      {
        _tag: "Completed",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [call("whole")],
          reasoning_content: null,
          output_parts: [{ type: "tool_call", tool_call_id: "whole", execution: "runtime" }],
          origin: { provider: "llama.cpp", api: "chat-completions", model: GEMMA }
        },
        finish_reason: "length",
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0
        },
        model: GEMMA
      }
    ])
  })
})

describe("Chat Completions call identity", () => {
  /** The calls a stream of `tool_calls` deltas yields, and the `ToolCallDelta` indexes the loop saw. */
  const callsOf = async (deltas: ReadonlyArray<Record<string, unknown>>) => {
    let generated = 0
    const { provider: cc } = provider(
      [
        () =>
          sseResponse([
            ...deltas.map((delta) => llamaChunk({ tool_calls: [delta] })),
            llamaChunk({}, "tool_calls"),
            "[DONE]"
          ])
      ],
      { generateId: () => `gen-${++generated}` }
    )
    const items = await collect(cc.stream(request()))
    const announced = items.flatMap((item) =>
      item._tag === "ToolCallDelta" && item.tool_id !== undefined
        ? [{ index: item.index, id: item.tool_id }]
        : []
    )
    return {
      calls: completionOf(items).message.tool_calls?.map((made) => ({
        id: made.id,
        name: made.function.name,
        arguments: made.function.arguments
      })),
      announced,
      closed: items.flatMap((item) =>
        item._tag === "ToolCallDelta" && item.done ? [item.index] : []
      )
    }
  }

  it("starts a new call when a new id arrives at an index already in use", async () => {
    expect(
      await callsOf([
        { index: 0, id: "a", function: { name: "read", arguments: '{"p"' } },
        { index: 0, function: { arguments: ":1}" } },
        { index: 0, id: "b", function: { name: "write", arguments: '{"q":2}' } }
      ])
    ).toEqual({
      calls: [
        { id: "a", name: "read", arguments: '{"p":1}' },
        { id: "b", name: "write", arguments: '{"q":2}' }
      ],
      announced: [
        { index: 0, id: "a" },
        { index: 1, id: "b" }
      ],
      closed: [0, 1]
    })
  })

  it("tells calls without an index apart by id, and continues the open call on a fragment", async () => {
    expect(
      await callsOf([
        { id: "a", function: { name: "read", arguments: '{"p"' } },
        { function: { arguments: ":1}" } },
        { id: "b", function: { name: "write", arguments: "{" } },
        { id: "b", function: { arguments: '"q":2}' } }
      ])
    ).toEqual({
      calls: [
        { id: "a", name: "read", arguments: '{"p":1}' },
        { id: "b", name: "write", arguments: '{"q":2}' }
      ],
      announced: [
        { index: 0, id: "a" },
        { index: 1, id: "b" }
      ],
      closed: [0, 1]
    })
  })

  it("reads fragments with neither index nor id as one call", async () => {
    expect(
      await callsOf([
        { function: { name: "read", arguments: '{"p"' } },
        { function: { arguments: ":1}" } }
      ])
    ).toEqual({
      calls: [{ id: "gen-1", name: "read", arguments: '{"p":1}' }],
      announced: [{ index: 0, id: "gen-1" }],
      closed: [0]
    })
  })

  it("keys calls with only an index by that index, whatever order they interleave in", async () => {
    expect(
      await callsOf([
        { index: 1, function: { name: "write", arguments: "{" } },
        { index: 0, function: { name: "read", arguments: '{"p":1}' } },
        { index: 1, function: { arguments: '"q":2}' } }
      ])
    ).toEqual({
      calls: [
        { id: "gen-1", name: "write", arguments: '{"q":2}' },
        { id: "gen-2", name: "read", arguments: '{"p":1}' }
      ],
      announced: [
        { index: 0, id: "gen-1" },
        { index: 1, id: "gen-2" }
      ],
      closed: [0, 1]
    })
  })
})

describe("a request that allows no tool call", () => {
  /** What llama.cpp b12359 streams for a call under `tool_choice: "none"`: the template's raw text. */
  const rawCall = '<|tool_call>call:weather{city:<|"|>Paris<|"|>}<tool_call|>'
  const callChunks = () =>
    sseResponse([
      llamaChunk({
        tool_calls: [
          { index: 0, id: "w1", function: { name: "weather", arguments: '{"city":"P"}' } }
        ]
      }),
      llamaChunk({}, "tool_calls"),
      "[DONE]"
    ])

  it("asks a server that only stops parsing calls for parsed ones, and refuses a call", async () => {
    // Live on b12359: with `tool_choice: "none"` the tools are still rendered (64 prompt
    // tokens against 20 without them) and a call came back as `rawCall` in `content`.
    expect(rawCall).toContain("<|tool_call>")
    const { provider: cc, transport } = provider([callChunks], {
      compat: { toolChoiceNone: "unenforced" }
    })
    await expect(
      collect(cc.stream(request({ tools: [weather], toolChoice: "none" })))
    ).rejects.toThrow("llama.cpp model called weather although the request allowed no tool call")
    expect(recordOf(transport.requests[0]?.body).tool_choice).toBeUndefined()
  })

  it("sends `none` where the server enforces it, and still refuses a call it lets through", async () => {
    const { provider: cc, transport } = provider([callChunks, answered("Sunny.")])
    await expect(
      collect(cc.stream(request({ tools: [weather], toolChoice: "none" })))
    ).rejects.toThrow("llama.cpp model called weather although the request allowed no tool call")
    expect(recordOf(transport.requests[0]?.body).tool_choice).toBe("none")
    expect(
      completionOf(await collect(cc.stream(request({ tools: [weather], toolChoice: "none" }))))
        .message.content
    ).toBe("Sunny.")
  })
})

describe("Chat Completions request body", () => {
  it("orders a multi-turn tool history: outputs follow calls, context waits, an interrupted call is closed", async () => {
    const { provider: cc, transport } = provider([answered("Ok.")])
    const history: ReadonlyArray<ChatMessage> = [
      { role: "system", content: "Base prompt." },
      { role: "system", content: "Background note." },
      {
        role: "user",
        content: [
          { type: "text", text: "Check both." },
          { type: "context", content_type: "page", content: "Body", metadata: { slug: "home" } }
        ]
      },
      {
        role: "assistant",
        content: "",
        reasoning_content: "Plan.",
        tool_calls: [call("call-a"), call("call-b", "Rome")]
      },
      { role: "tool", tool_call_id: "call-a", content: "A out" },
      { role: "developer", content: "Current run context" },
      { role: "user", content: "Steering while b runs" },
      { role: "tool", tool_call_id: "call-b", content: "B out" },
      { role: "assistant", content: "", reasoning_content: "Thinking only." },
      { role: "user", content: "", async_tool_launch: { call_id: "call-b", delivery: "message" } },
      { role: "assistant", content: "Retrying.", tool_calls: [call("call-c")] },
      { role: "user", content: "Continue." }
    ]

    await collect(cc.stream(request({ messages: history, tools: [weather] })))

    expect(transport.requests[0]?.body).toEqual({
      model: GEMMA,
      messages: [
        { role: "system", content: "Base prompt.\n\nBackground note." },
        {
          role: "user",
          content: [
            { type: "text", text: "Check both." },
            { type: "text", text: '<page slug="home">\nBody\n</page>' }
          ]
        },
        { role: "assistant", content: "", tool_calls: [call("call-a"), call("call-b", "Rome")] },
        { role: "tool", tool_call_id: "call-a", content: "A out" },
        { role: "tool", tool_call_id: "call-b", content: "B out" },
        { role: "system", content: "Current run context" },
        { role: "user", content: "Steering while b runs" },
        { role: "assistant", content: "Retrying.", tool_calls: [call("call-c")] },
        { role: "tool", tool_call_id: "call-c", content: MISSING_TOOL_OUTPUT },
        { role: "user", content: "Continue." }
      ],
      stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: "function", function: weather }]
    })
  })

  const flagged = {
    model: GEMMA,
    messages: [
      { role: "system", content: "Base." },
      { role: "user", content: "Hi." },
      { role: "assistant", content: "Hello." },
      { role: "user", content: "Again." }
    ] satisfies ReadonlyArray<ChatMessage>,
    tools: [weather],
    toolChoice: "required" as const,
    maxOutputTokens: 256,
    reasoningEffort: "high"
  }

  it.each([
    {
      compat: {},
      extra: {},
      body: {
        model: GEMMA,
        messages: flagged.messages,
        stream: true,
        stream_options: { include_usage: true },
        tools: [{ type: "function", function: weather }],
        tool_choice: "required",
        max_completion_tokens: 256
      }
    },
    {
      compat: { reasoningEffort: "reasoning_effort", usageInStream: false } as const,
      extra: {},
      body: {
        model: GEMMA,
        messages: flagged.messages,
        stream: true,
        tools: [{ type: "function", function: weather }],
        tool_choice: "required",
        max_completion_tokens: 256,
        reasoning_effort: "high"
      }
    },
    {
      compat: {
        maxTokensField: "max_tokens",
        systemRole: "developer",
        reasoningEffort: "openrouter",
        structuredOutput: "json_schema",
        imageInput: true,
        parallelToolCalls: true,
        cacheControl: "anthropic"
      } as const,
      extra: {
        responseFormat: { name: "reading", schema: { type: "object" } },
        messages: [
          ...flagged.messages.slice(0, 3),
          {
            role: "user",
            content: [
              { type: "image", media_type: "image/png", data: "iVBOR" },
              { type: "text", text: "Again." }
            ]
          }
        ] satisfies ReadonlyArray<ChatMessage>
      },
      body: {
        provider: { order: ["anthropic"] },
        model: GEMMA,
        messages: [
          {
            role: "developer",
            content: [{ type: "text", text: "Base.", cache_control: { type: "ephemeral" } }]
          },
          { role: "user", content: "Hi." },
          { role: "assistant", content: "Hello." },
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } },
              { type: "text", text: "Again.", cache_control: { type: "ephemeral" } }
            ]
          }
        ],
        stream: true,
        stream_options: { include_usage: true },
        tools: [{ type: "function", function: weather, cache_control: { type: "ephemeral" } }],
        tool_choice: "required",
        parallel_tool_calls: true,
        max_tokens: 256,
        reasoning: { effort: "high" },
        response_format: {
          type: "json_schema",
          json_schema: { name: "reading", schema: { type: "object" }, strict: true }
        }
      }
    }
  ])("sends compat $compat as its documented body", async ({ compat, extra, body }) => {
    const { provider: cc, transport } = provider([answered("Ok.")], {
      compat,
      ...("responseFormat" in extra ? { extraBody: { provider: { order: ["anthropic"] } } } : {})
    })
    await collect(cc.stream(request({ ...flagged, ...extra })))
    expect(transport.requests[0]?.body).toEqual(body)
  })

  it("declares structured output only for a json_schema route and refuses fields it writes itself", async () => {
    expect(await provider([]).provider.capabilities?.(GEMMA)).toEqual({
      hostedTools: [],
      structuredOutput: "none",
      asyncTools: "message",
      steering: "boundary",
      toolSearch: "client"
    })
    expect(
      await provider([], { compat: { structuredOutput: "json_schema" } }).provider.capabilities?.(
        GEMMA
      )
    ).toMatchObject({ structuredOutput: "native" })
    expect(() => provider([], { extraBody: { model: "x", messages: [] } })).toThrow(
      "llama.cpp extraBody may not set model, messages: the adapter writes them"
    )
  })

  it("tells the host a route takes images, with no limits it does not state", async () => {
    const vision = await provider([], { compat: { imageInput: true } }).provider.capabilities?.(
      GEMMA
    )
    const text = await provider([]).provider.capabilities?.(GEMMA)
    expect([vision?.imageInput, text?.imageInput]).toEqual([{ limits: undefined }, undefined])
  })

  it("tells a model without image input that an image was left out, instead of failing every request", async () => {
    const { provider: cc, transport } = provider([answered("I cannot see it.")])
    const image: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image", media_type: "image/png", data: "iVBOR" }
      ]
    }
    await collect(cc.stream(request({ messages: [image] })))
    expect(sentMessages(transport.requests[0]?.body)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "text", text: "(image omitted: this model does not take image input)" }
        ]
      }
    ])
  })
})

describe("OpenRouter reasoning_details", () => {
  const routerChunk = (delta: unknown, finish: string | null = null) => ({
    id: "gen-1",
    provider: "OpenAI",
    model: "openai/gpt-5-mini",
    object: "chat.completion.chunk",
    created: 1794771400,
    choices: [{ index: 0, delta, finish_reason: finish, native_finish_reason: finish }]
  })
  const format = "openai-responses-v1"
  const details = [
    { type: "reasoning.summary", summary: "Plan it.", index: 0, format },
    { type: "reasoning.encrypted", data: "enc-blob", id: "rs_1", index: 1, format }
  ]

  it("accumulates fragments by index, stores them, and replays them only to the same origin", async () => {
    const router = provider(
      [
        () =>
          sseResponse([
            routerChunk({
              role: "assistant",
              content: "",
              reasoning: "Plan",
              reasoning_details: [{ type: "reasoning.summary", summary: "Plan", index: 0, format }]
            }),
            routerChunk({
              reasoning: " it.",
              reasoning_details: [{ type: "reasoning.summary", summary: " it.", index: 0, format }]
            }),
            routerChunk({
              reasoning_details: [
                { type: "reasoning.encrypted", data: "enc-blob", id: "rs_1", index: 1, format }
              ]
            }),
            routerChunk({ content: "Done." }),
            routerChunk({}, "stop"),
            {
              ...routerChunk({}),
              choices: [],
              usage: {
                prompt_tokens: 30,
                completion_tokens: 12,
                prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 4 },
                cost: 0.0001
              }
            },
            "[DONE]"
          ]),
        answered("Again."),
        answered("Again."),
        answered("Again.")
      ],
      { providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }
    )

    const completed = completionOf(
      await collect(router.provider.stream(request({ model: "openai/gpt-5-mini" })))
    )
    expect(completed).toEqual({
      _tag: "Completed",
      message: {
        role: "assistant",
        content: "Done.",
        tool_calls: null,
        reasoning_content: "Plan it.",
        output_parts: [
          { type: "reasoning", text: "Plan it." },
          { type: "text", text: "Done." }
        ],
        provider_state: { "chat-completions": { reasoning_details: details } },
        origin: { provider: "openrouter", api: "chat-completions", model: "openai/gpt-5-mini" }
      },
      finish_reason: "stop",
      usage: {
        prompt_tokens: 20,
        completion_tokens: 12,
        cache_read_tokens: 6,
        cache_write_tokens: 4
      },
      model: "openai/gpt-5-mini"
    })

    const stored: AssistantMessage = {
      role: "assistant",
      content: "Done.",
      provider_state: defined(completed.message.provider_state, "provider state"),
      origin: defined(completed.message.origin, "an origin")
    }
    const messages: ReadonlyArray<ChatMessage> = [
      { role: "user", content: "Q" },
      stored,
      { role: "user", content: "Next" }
    ]
    const other = provider([answered("Again.")], {
      providerId: "other-router",
      baseUrl: "https://example.test/v1"
    })
    await collect(router.provider.stream(request({ model: "openai/gpt-5-mini", messages })))
    await collect(
      router.provider.stream(request({ model: "anthropic/claude-sonnet-4.5", messages }))
    )
    await collect(other.provider.stream(request({ model: "openai/gpt-5-mini", messages })))

    const replayed = [...router.transport.requests.slice(1), ...other.transport.requests].map(
      (sent) => (sentMessages(sent.body) as ReadonlyArray<unknown>)[1]
    )
    expect(replayed).toEqual([
      { role: "assistant", content: "Done.", reasoning_details: details },
      { role: "assistant", content: "Done." },
      { role: "assistant", content: "Done." }
    ])
  })
})

describe("Chat Completions failures", () => {
  it("retries an OpenRouter mid-stream error frame and fails a terminal one with its class", async () => {
    const frame = (code: number, message: string) => ({
      id: "gen-2",
      object: "chat.completion.chunk",
      model: "openai/gpt-5-mini",
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
    expect(transport.requests.map((sent) => sent.headers)).toEqual([
      {
        authorization: "Bearer token-1",
        "x-title": "Arden",
        accept: "text/event-stream",
        "content-type": "application/json"
      },
      {
        authorization: "Bearer token-2",
        "x-title": "Arden",
        accept: "text/event-stream",
        "content-type": "application/json"
      }
    ])
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
        code: "context_length_exceeded",
        message: `llama.cpp request failed with status 400: ${LLAMA_OVERFLOW}`
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
  ).run([{ role: "user", content: "Hi." }])

  const assistant = defined(
    result.messages.find((message) => message.role === "assistant"),
    "an assistant message"
  )
  expect(assistant).toEqual({
    message_id: expect.any(String),
    client_id: expect.any(String),
    role: "assistant",
    content: "Hi there.",
    output_parts: [{ type: "text", text: "Hi there." }],
    origin: { provider: "llama.cpp", api: "chat-completions", model: GEMMA }
  })
  expect(decodeMessage(JSON.parse(JSON.stringify(assistant)))).toEqual(assistant)
  expect(() => decodeMessage({ ...assistant, origin: { provider: "llama.cpp" } })).toThrow()
})

describe("Chat Completions client tool search", () => {
  const shell = {
    name: "shell_run",
    description: "Run a shell command and return its output.\nUse for files and processes.",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    group: "system"
  }
  const mail = {
    name: "mail_send",
    description: "Send an email.",
    parameters: { type: "object", properties: { to: { type: "string" } } },
    group: "mail"
  }
  const search = makeToolSearch({
    catalog: [shell, mail].map((declaration) => ({
      declaration,
      meta: { name: declaration.name, deferred: true, group: declaration.group }
    })),
    loaded: new Set()
  })
  const searchTool = {
    type: "function",
    function: {
      name: "tool_search",
      description: search.description,
      parameters: search.parameters
    }
  }
  const wire = (tool: { name: string; description: string; parameters: unknown }) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  })
  const searchRequest = (overrides: Partial<ModelProviderRequest> = {}) =>
    request({ tools: [weather], deferredTools: [shell, mail], toolSearch: search, ...overrides })
  const SHELL_LOADED =
    "Loaded 1 tool; call it directly now:\n- shell_run: Run a shell command and return its output."
  const searchChunk = (id: string, args: string, index = 0) =>
    llamaChunk({
      tool_calls: [
        { index, id, type: "function", function: { name: "tool_search", arguments: args } }
      ]
    })

  it("declares the search, the core tools and nothing deferred until the history loads it", async () => {
    const { provider: cc, transport } = provider([answered("Ok."), answered("Ok.")])
    await collect(cc.stream(searchRequest()))
    await collect(cc.stream(request({ tools: [weather], deferredTools: [] })))
    expect(transport.requests.map((sent) => recordOf(sent.body).tools)).toEqual([
      [wire(weather), searchTool],
      [wire(weather)]
    ])
  })

  it("answers a search call itself and hands the loop a provider call that continues the run", async () => {
    const { provider: cc } = provider([
      () =>
        sseResponse([
          llamaChunk({ role: "assistant", content: null }),
          searchChunk("srch", '{"query":'),
          llamaChunk({ tool_calls: [{ index: 0, function: { arguments: '"shell"}' } }] }),
          llamaChunk({}, "tool_calls"),
          llamaUsage,
          "[DONE]"
        ])
    ])

    const items = await collect(cc.stream(searchRequest()))

    expect(items).toEqual([
      {
        _tag: "ProviderToolCall",
        call: {
          id: "srch",
          name: "tool_search",
          arguments: {},
          result: "",
          done: false,
          loaded_tool_names: [],
          source_refs: []
        }
      },
      {
        _tag: "Completed",
        continuation: true,
        message: {
          role: "assistant",
          content: null,
          tool_calls: null,
          reasoning_content: null,
          output_parts: [{ type: "tool_call", tool_call_id: "srch", execution: "provider" }],
          provider_tool_calls: [
            {
              id: "srch",
              name: "tool_search",
              arguments: { query: "shell" },
              result: SHELL_LOADED,
              done: true,
              loaded_tool_names: ["shell_run"],
              source_refs: []
            }
          ],
          origin: { provider: "llama.cpp", api: "chat-completions", model: GEMMA }
        },
        finish_reason: "stop",
        usage: {
          prompt_tokens: 5,
          completion_tokens: 199,
          cache_read_tokens: 71,
          cache_write_tokens: 0
        },
        model: GEMMA
      }
    ])
  })

  it("keeps an ordinary call in the same response a runtime call, in the order the model wrote them", async () => {
    const { provider: cc } = provider([
      () =>
        sseResponse([
          llamaChunk({ content: "Both." }),
          llamaChunk({
            tool_calls: [
              { index: 0, id: "w1", function: { name: "weather", arguments: '{"city":"Paris"}' } }
            ]
          }),
          searchChunk("s1", '{"query":"mail","limit":1}', 1),
          llamaChunk({}, "tool_calls"),
          "[DONE]"
        ])
    ])

    const items = await collect(cc.stream(searchRequest()))

    expect(items.map((item) => item._tag)).toEqual([
      "TextDelta",
      "ToolCallDelta",
      "ProviderToolCall",
      "ToolCallDelta",
      "Completed"
    ])
    const completed = completionOf(items)
    expect(completed).toMatchObject({ continuation: true, finish_reason: "tool_calls" })
    expect(completed.message).toEqual({
      role: "assistant",
      content: "Both.",
      tool_calls: [call("w1")],
      reasoning_content: null,
      output_parts: [
        { type: "text", text: "Both." },
        { type: "tool_call", tool_call_id: "w1", execution: "runtime" },
        { type: "tool_call", tool_call_id: "s1", execution: "provider" }
      ],
      provider_tool_calls: [
        {
          id: "s1",
          name: "tool_search",
          arguments: { query: "mail", limit: 1 },
          result: "Loaded 1 tool; call it directly now:\n- mail_send: Send an email.",
          done: true,
          loaded_tool_names: ["mail_send"],
          source_refs: []
        }
      ],
      origin: { provider: "llama.cpp", api: "chat-completions", model: GEMMA }
    })
  })

  it("answers malformed search arguments with a correction instead of failing the run", async () => {
    const { provider: cc } = provider([
      () =>
        sseResponse([searchChunk("bad1", "shell please"), llamaChunk({}, "tool_calls"), "[DONE]"]),
      () =>
        sseResponse([searchChunk("bad2", '{"q":"shell"}'), llamaChunk({}, "tool_calls"), "[DONE]"])
    ])
    const calls = [
      completionOf(await collect(cc.stream(searchRequest()))),
      completionOf(await collect(cc.stream(searchRequest())))
    ].map((completed) => completed.message.provider_tool_calls)

    const hint = 'Call tool_search again with one JSON object such as {"query": "send email"}.'
    expect(calls).toEqual([
      [
        {
          id: "bad1",
          name: "tool_search",
          arguments: {},
          result: `tool_search arguments are not valid JSON. ${hint}`,
          done: true,
          loaded_tool_names: [],
          source_refs: []
        }
      ],
      [
        {
          id: "bad2",
          name: "tool_search",
          arguments: { q: "shell" },
          result: `tool_search needs a non-empty string "query". ${hint}`,
          done: true,
          loaded_tool_names: [],
          source_refs: []
        }
      ]
    ])
  })

  it("replays the search exchange as a call and its result, and declares what it loaded", async () => {
    const { provider: cc, transport } = provider([
      () =>
        sseResponse([
          searchChunk("srch", '{"query":"shell"}'),
          llamaChunk({}, "tool_calls"),
          "[DONE]"
        ]),
      answered("Ok.")
    ])
    const first = completionOf(await collect(cc.stream(searchRequest())))
    const stored: AssistantMessage = {
      role: "assistant",
      content: "",
      provider_tool_calls: defined(first.message.provider_tool_calls ?? undefined, "a search"),
      output_parts: defined(first.message.output_parts ?? undefined, "output parts"),
      origin: defined(first.message.origin, "an origin")
    }
    await collect(
      cc.stream(searchRequest({ messages: [{ role: "user", content: "List files." }, stored] }))
    )

    expect(transport.requests[1]?.body).toEqual({
      model: GEMMA,
      messages: [
        { role: "user", content: "List files." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "srch",
              type: "function",
              function: { name: "tool_search", arguments: '{"query":"shell"}' }
            }
          ]
        },
        { role: "tool", tool_call_id: "srch", content: SHELL_LOADED }
      ],
      stream: true,
      stream_options: { include_usage: true },
      tools: [wire(weather), searchTool, wire(shell)]
    })
  })

  it("keeps the tools a Responses search loaded, and follows compaction and removal records", async () => {
    const responsesTurn: AssistantMessage = {
      role: "assistant",
      content: "",
      provider_tool_calls: [
        {
          id: "tsc_1",
          name: "tool_search",
          arguments: { query: "mail" },
          result: "Loaded: mail_send",
          done: true,
          loaded_tool_names: ["mail_send"],
          source_refs: []
        },
        {
          id: "ws_1",
          name: "web_search",
          arguments: { query: "news" },
          result: "",
          done: true,
          loaded_tool_names: [],
          source_refs: []
        }
      ],
      output_parts: [
        { type: "tool_call", tool_call_id: "ws_1", execution: "provider" },
        { type: "tool_call", tool_call_id: "tsc_1", execution: "provider" }
      ],
      provider_state: { "openai-responses": [{ type: "tool_search_call", id: "tsc_1" }] },
      origin: { provider: "openai", api: "openai-responses", model: "gpt-5.4" }
    }
    const { provider: cc, transport } = provider([answered("Ok."), answered("Ok.")])
    await collect(
      cc.stream(searchRequest({ messages: [{ role: "user", content: "Mail Bo." }, responsesTurn] }))
    )
    const compacted: ReadonlyArray<ChatMessage> = [
      { role: "user", content: "Summary of earlier work." },
      {
        role: "developer",
        content: "Tools still loaded from earlier in this conversation: mail_send, shell_run.",
        loaded_tools: ["shell_run", "mail_send"]
      },
      {
        role: "developer",
        content: "Tools changed in this conversation. No longer available: shell_run.",
        removed_tools: ["shell_run"]
      },
      { role: "user", content: "Go on." }
    ]
    await collect(cc.stream(searchRequest({ messages: compacted })))

    expect(transport.requests.map((sent) => recordOf(sent.body).messages)).toEqual([
      [
        { role: "user", content: "Mail Bo." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "tsc_1",
              type: "function",
              function: { name: "tool_search", arguments: '{"query":"mail"}' }
            }
          ]
        },
        { role: "tool", tool_call_id: "tsc_1", content: "Loaded: mail_send" }
      ],
      [
        { role: "user", content: "Summary of earlier work." },
        {
          role: "system",
          content: "Tools still loaded from earlier in this conversation: mail_send, shell_run."
        },
        {
          role: "system",
          content: "Tools changed in this conversation. No longer available: shell_run."
        },
        { role: "user", content: "Go on." }
      ]
    ])
    expect(transport.requests.map((sent) => recordOf(sent.body).tools)).toEqual([
      [wire(weather), searchTool, wire(mail)],
      [wire(weather), searchTool, wire(mail)]
    ])
  })

  it("replays a search answered here on the Responses wire as native search items", async () => {
    const chatTurn: AssistantMessage = {
      role: "assistant",
      content: "Looking.",
      provider_tool_calls: [
        {
          id: "srch",
          name: "tool_search",
          arguments: { query: "shell" },
          result: SHELL_LOADED,
          done: true,
          loaded_tool_names: ["shell_run"],
          source_refs: []
        }
      ],
      origin: { provider: "llama.cpp", api: "chat-completions", model: GEMMA }
    }
    const transport = scriptedFetch([
      () =>
        sseResponse([
          { type: "response.completed", response: { output: [], usage: null, end_turn: true } }
        ])
    ])
    const responses = makeOpenAiResponsesProvider({
      auth: { headers: async () => ({ authorization: "Bearer t" }) },
      fetch: transport.fetch
    })
    const messages: ReadonlyArray<ChatMessage> = [
      { role: "user", content: "List files." },
      chatTurn,
      { role: "user", content: "Again." }
    ]
    await collect(responses.stream(searchRequest({ model: "gpt-5.4", messages })))
    expect(recordOf(transport.requests[0]?.body).input).toEqual([
      { role: "user", content: "List files." },
      { role: "assistant", content: "Looking." },
      {
        type: "tool_search_call",
        call_id: "srch",
        execution: "client",
        status: "completed",
        arguments: { query: "shell" }
      },
      {
        type: "tool_search_output",
        call_id: "srch",
        execution: "client",
        status: "completed",
        tools: [
          {
            type: "namespace",
            name: "system",
            description: "Tools in the system namespace.",
            tools: [
              {
                type: "function",
                name: "shell_run",
                description: shell.description,
                parameters: shell.parameters,
                strict: false,
                defer_loading: true
              }
            ]
          }
        ]
      },
      { role: "user", content: "Again." }
    ])

    const ownTurnWithoutItems: AssistantMessage = {
      ...chatTurn,
      origin: { provider: "openai", api: "openai-responses", model: "gpt-5.4" }
    }
    expect(() =>
      responses.stream(
        searchRequest({
          model: "gpt-5.4",
          messages: [messages[0] as ChatMessage, ownTurnWithoutItems]
        })
      )
    ).toThrow("Stored provider tool history requires matching OpenAI response items")
  })

  it("runs search, then the loaded tool, then the answer through makeAgent", async () => {
    const { provider: cc, transport } = provider([
      () =>
        sseResponse([
          searchChunk("srch", '{"query":"shell command"}'),
          llamaChunk({}, "tool_calls"),
          "[DONE]"
        ]),
      () =>
        sseResponse([
          llamaChunk({
            tool_calls: [
              {
                index: 0,
                id: "run1",
                function: { name: "shell_run", arguments: '{"command":"ls"}' }
              }
            ]
          }),
          llamaChunk({}, "tool_calls"),
          "[DONE]"
        ]),
      answered("Two files: a.txt and b.txt.")
    ])
    const executed: Array<string> = []
    const result = await makeAgent(
      { model: GEMMA },
      {
        provider: cc,
        toolset: {
          entries: () =>
            [weather, shell, mail].map((tool) => ({
              description: tool.description,
              parameters: tool.parameters,
              meta: {
                name: tool.name,
                ...("group" in tool ? { deferred: true, group: tool.group } : {})
              }
            })),
          loadedNames: () => new Set(),
          load: () => {},
          execute: (call) => {
            executed.push(`${call.name} ${JSON.stringify(call.args)}`)
            return { content: "a.txt\nb.txt", preview: "2 files" }
          }
        }
      }
    ).run([{ role: "user", content: "List my files." }])

    expect(result.text).toBe("Two files: a.txt and b.txt.")
    expect(executed).toEqual(['shell_run {"command":"ls"}'])
    const sent = transport.requests.map((request) => recordOf(request.body))
    expect(
      sent.map((body) =>
        (body.tools as ReadonlyArray<{ function: { name: string } }>).map(
          (tool) => tool.function.name
        )
      )
    ).toEqual([
      ["weather", "tool_search"],
      ["weather", "tool_search", "shell_run"],
      ["weather", "tool_search", "shell_run"]
    ])
    // The first message is the loop's background-tools note.
    expect((sentMessages(sent[2]) as ReadonlyArray<unknown>).slice(1)).toEqual([
      { role: "user", content: "List my files." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "srch",
            type: "function",
            function: { name: "tool_search", arguments: '{"query":"shell command"}' }
          }
        ]
      },
      {
        role: "tool",
        tool_call_id: "srch",
        content: SHELL_LOADED
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "run1",
            type: "function",
            function: { name: "shell_run", arguments: '{"command":"ls"}' }
          }
        ]
      },
      { role: "tool", tool_call_id: "run1", content: "a.txt\nb.txt" }
    ])
  })
})
