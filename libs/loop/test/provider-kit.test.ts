import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  classifyRejection,
  httpRejection,
  MISSING_TOOL_OUTPUT,
  orderToolHistory,
  ProviderStatusError,
  type ToolHistoryWire
} from "../src/providers/kit/index.js"
import type { ProviderErrorCode } from "../src/errors.js"
import {
  errorFrameFailure,
  statusFailureCode as chatCompletionsStatusCode
} from "../src/providers/chat-completions/errors.js"
import { statusFailureCode as responsesStatusCode } from "../src/providers/openai-responses/errors.js"

/**
 * Real rejection bodies, each with the class the host must see. A status that
 * names its class (401/403 auth, 429 throttle, 5xx unavailable) is never an
 * overflow by prose; overflow prose is read only from the server's own message
 * field, never from the body around it or a router's relayed upstream payload.
 */
const REJECTIONS: ReadonlyArray<
  readonly [name: string, status: number, body: string | undefined, expected: ProviderErrorCode]
> = [
  [
    "OpenAI throttle on tokens per minute",
    429,
    '{"error":{"message":"Rate limit reached for gpt-4o in organization org-abc on tokens per min (TPM): Limit 30000, Used 28000, Requested 4000. Please try again in 4.2s.","type":"tokens","param":null,"code":"rate_limit_exceeded"}}',
    "rate_limited"
  ],
  [
    "throttle that says too many tokens",
    429,
    '{"error":{"message":"Tokens per minute limit exceeded - too many tokens processed."}}',
    "rate_limited"
  ],
  [
    "OpenAI quota",
    429,
    '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}',
    "rate_limited"
  ],
  [
    "OpenRouter upstream throttle relaying a token limit",
    429,
    '{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"{\\"error\\":{\\"message\\":\\"Daily token limit exceeded\\"}}","provider_name":"DeepInfra"}}}',
    "rate_limited"
  ],
  [
    "OpenRouter credit cap (its token_limit_exceeded)",
    400,
    '{"error":{"message":"Token limit exceeded for this key","code":400}}',
    "provider_error"
  ],
  [
    "OpenRouter overflow",
    400,
    '{"error":{"message":"This endpoint\'s maximum context length is 8192 tokens. However, you requested about 9000 tokens (8000 of text input, 1000 in the output). Please reduce the length of either one, or use the \\"middle-out\\" transform to compress your prompt automatically.","code":400}}',
    "context_length_exceeded"
  ],
  [
    "OpenAI overflow",
    400,
    '{"error":{"message":"This model\'s maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens. Please reduce the length of the messages.","type":"invalid_request_error","param":"messages","code":"context_length_exceeded"}}',
    "context_length_exceeded"
  ],
  [
    "OpenAI overflow said only in prose",
    400,
    '{"error":{"message":"Your input exceeds the context window of this model. Please adjust your input and try again.","type":"invalid_request_error","param":"input","code":null}}',
    "context_length_exceeded"
  ],
  [
    "llama.cpp overflow",
    400,
    '{"error":{"code":400,"message":"request (6016 tokens) exceeds the available context size (4096 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":6016,"n_ctx":4096}}',
    "context_length_exceeded"
  ],
  [
    "nginx body limit",
    413,
    "<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n",
    "context_length_exceeded"
  ],
  [
    "Anthropic overflow in OpenRouter's message",
    400,
    '{"error":{"message":"prompt is too long: 201234 tokens > 200000 maximum","code":400,"metadata":{"provider_name":"Anthropic"}}}',
    "context_length_exceeded"
  ],
  [
    "Anthropic overflow only in OpenRouter's relayed payload",
    400,
    '{"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"prompt is too long: 201234 tokens > 200000 maximum\\"}}","provider_name":"Anthropic"}}}',
    "provider_error"
  ],
  [
    "output limit above the model's cap",
    400,
    '{"error":{"message":"max_tokens is too large: 65536. This model supports at most 32768 completion tokens, whereas you provided 65536.","type":"invalid_request_error","param":"max_tokens","code":null}}',
    "request_invalid"
  ],
  [
    "Ollama overflow",
    400,
    '{"error":"prompt too long; exceeded max context length by 100 tokens"}',
    "context_length_exceeded"
  ],
  [
    "server error that mentions the context window",
    500,
    '{"error":{"message":"failed to allocate the context window","type":"server_error"}}',
    "provider_unavailable"
  ],
  [
    "Codex model refused",
    400,
    `{"detail":"The 'gpt-5.5-pro' model is not supported when using Codex with a ChatGPT account."}`,
    "model_unavailable"
  ],
  [
    "llama.cpp unknown model",
    400,
    `{"error":{"code":400,"message":"model 'nope/missing-model' not found","type":"invalid_request_error"}}`,
    "model_unavailable"
  ],
  [
    "llama.cpp bad request",
    400,
    `{"error":{"code":400,"message":"Expected 'messages' to be an array","type":"invalid_request_error"}}`,
    "request_invalid"
  ],
  [
    "llama.cpp loading",
    503,
    '{"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}',
    "provider_unavailable"
  ],
  ["bad key", 401, '{"error":{"message":"No auth credentials found","code":401}}', "provider_auth"],
  ["teapot", 418, undefined, "provider_error"]
]

describe("rejection classification", () => {
  it("reads every server's real rejection into one taxonomy, on both wires", () => {
    const expected = Object.fromEntries(REJECTIONS.map(([name, , , code]) => [name, code]))
    const on = (classify: (status: number, body: string | undefined) => ProviderErrorCode) =>
      Object.fromEntries(REJECTIONS.map(([name, status, body]) => [name, classify(status, body)]))
    expect(on((status, body) => classifyRejection(httpRejection(status, body), {}))).toEqual(
      expected
    )
    expect(on(chatCompletionsStatusCode)).toEqual(expected)
    expect(on((status, body) => responsesStatusCode(status, body ?? null))).toEqual(expected)
  })

  it("classifies a body longer than the clipped detail by its fields", () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message: "Provider returned error",
        metadata: { raw: "x".repeat(2000), error_type: "context_length_exceeded" }
      }
    })
    const failure = new ProviderStatusError({
      label: "test",
      status: 400,
      retryAfter: null,
      retryAfterMs: null,
      detail: body,
      classify: chatCompletionsStatusCode
    })
    expect(failure.code).toBe("context_length_exceeded")
  })

  it("classifies a mid-stream error frame by the same rules", () => {
    const frames: ReadonlyArray<readonly [string, unknown, ProviderErrorCode]> = [
      [
        "OpenRouter throttle relaying a token limit",
        {
          error: {
            code: 429,
            message: "Provider returned error",
            metadata: { raw: '{"error":{"message":"Daily token limit exceeded"}}' }
          }
        },
        "rate_limited"
      ],
      [
        "OpenRouter overflow named only by its typed class",
        {
          error: {
            code: 400,
            message: "Provider returned error",
            metadata: { error_type: "context_length_exceeded", provider_code: "invalid_request" }
          }
        },
        "context_length_exceeded"
      ],
      [
        "llama.cpp overflow",
        {
          error: {
            code: 400,
            message: "request (6016 tokens) exceeds the available context size (4096 tokens)",
            type: "exceed_context_size_error"
          }
        },
        "context_length_exceeded"
      ],
      [
        "frame without a status that mentions the context window",
        { error: { message: "context window warming up" } },
        "provider_error"
      ]
    ]
    expect(
      Object.fromEntries(
        frames.map(([name, frame]) => [name, errorFrameFailure("test", frame).code])
      )
    ).toEqual(Object.fromEntries(frames.map(([name, , code]) => [name, code])))
  })
})

describe("tool-history ordering", () => {
  type Item =
    | { readonly kind: "call"; readonly ids: ReadonlyArray<string> }
    | { readonly kind: "output"; readonly id: string }
    | { readonly kind: "note"; readonly text: string }
  const wire: ToolHistoryWire<Item> = {
    name: "test history",
    calls: (item) => (item.kind === "call" ? item.ids.map((id) => ({ id, async: false })) : []),
    answers: (item) => (item.kind === "output" ? { id: item.id } : undefined),
    missingOutput: (id) => ({ kind: "output", id: `${id} (${MISSING_TOOL_OUTPUT})` }),
    fail: (message) => new Error(message)
  }

  it("moves a later-recorded output up to the interruption that needs it", () => {
    const calls: Item = { kind: "call", ids: ["a", "b"] }
    const outputA: Item = { kind: "output", id: "a" }
    const outputB: Item = { kind: "output", id: "b" }
    const steering: Item = { kind: "note", text: "steering" }
    const interruption: Item = { kind: "note", text: "interaction" }
    expect(
      orderToolHistory(
        [
          { items: [calls], deferWhileCallsPending: false },
          { items: [outputA], deferWhileCallsPending: false },
          { items: [steering], deferWhileCallsPending: true },
          { items: [interruption], deferWhileCallsPending: false },
          { items: [outputB], deferWhileCallsPending: false }
        ],
        wire
      )
    ).toEqual([calls, outputA, outputB, steering, interruption])
    expect(() =>
      orderToolHistory(
        [{ items: [{ kind: "output", id: "x" }], deferWhileCallsPending: false }],
        wire
      )
    ).toThrow("Stored test history contains output without matching function call x")
  })
})

/**
 * The guard against a second copy: transport, rejection prose, tool-history
 * ordering, context rendering and the tool-search answer live in the kit (the
 * loaded-tool derivation in the contracts, shared with the loop), and an
 * adapter that grows its own again fails here.
 */
it("keeps shared provider machinery in the kit only", () => {
  const providers = join(import.meta.dirname, "../src/providers")
  const owned: ReadonlyArray<readonly [RegExp, string]> = [
    [/readSseEvents\(/, "the SSE transport (kit streamSse)"],
    [/retryAfterHints\(/, "the status read (kit streamSse)"],
    [/\.getReader\(/, "the body read (kit streamSse)"],
    [/Tool output was not recorded/, "the missing tool output (kit orderToolHistory)"],
    [/context (?:length|window)/, "the overflow prose (kit isContextOverflow)"],
    [
      /\bmodel\b.{0,80}?(?:is not supported|does not exist)/i,
      "the model-unavailable prose (kit classifyRejection)"
    ],
    [/<\/\$\{/, "the context block rendering (kit contextBlockText)"],
    [/= "tool_search"/, "the search tool name (kit TOOL_SEARCH_TOOL_NAME)"],
    [/No tools matched|\.search\(\{/, "the search answer (kit answerToolSearch)"],
    [/\.removed_tools/, "the loaded-tool derivation (contracts loadedToolNames)"]
  ]
  const copies = readdirSync(providers, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "kit")
    .flatMap((adapter) =>
      readdirSync(join(providers, adapter.name)).flatMap((file) => {
        const source = readFileSync(join(providers, adapter.name, file), "utf8")
        return owned.flatMap(([needle, what]) =>
          needle.test(source) ? [`${adapter.name}/${file} copies ${what}`] : []
        )
      })
    )
  expect(copies).toEqual([])
})
