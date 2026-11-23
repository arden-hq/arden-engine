import { ROLE } from "@arden-hq/std/message-vocabulary"
import { errorMessage } from "@arden-hq/std/errors"
import { describe, expect, it } from "vitest"

import {
  classifyRejection,
  httpRejection,
  MISSING_TOOL_OUTPUT,
  orderToolHistory,
  ProviderStatusError,
  type ToolHistoryWire
} from "../src/providers/kit/index.js"
import type { ModelProvider, ModelProviderRequest } from "../src/contracts/provider.js"
import type { ProviderErrorCode } from "../src/errors.js"
import { ProviderError } from "../src/providers/kit/errors.js"
import { makeChatCompletionsProvider } from "../src/providers/chat-completions/provider.js"
import { makeOpenAiResponsesProvider } from "../src/providers/openai-responses/provider.js"
import {
  errorFrameFailure,
  statusFailureCode as chatCompletionsStatusCode
} from "../src/providers/chat-completions/errors.js"
import { statusFailureCode as responsesStatusCode } from "../src/providers/openai-responses/errors.js"

const REJECTIONS: ReadonlyArray<
  readonly [name: string, status: number, body: string | undefined, expected: ProviderErrorCode]
> = [
  [
    "OpenAI throttle on tokens per minute",
    429,
    '{"error":{"message":"Rate limit reached for gpt-6-luna in organization org-abc on tokens per min (TPM): Limit 30000, Used 28000, Requested 4000. Please try again in 4.2s.","type":"tokens","param":null,"code":"rate_limit_exceeded"}}',
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
    JSON.stringify({
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: {
          raw: '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 600023 tokens > 200000 maximum"},"request_id":"req_vrtx_011Ch5YakJbXmpFiana6sm4X"}',
          provider_name: "Google",
          is_byok: false
        }
      }
    }),
    "context_length_exceeded"
  ],
  [
    "OpenAI refusing a tool schema, relayed by OpenRouter",
    400,
    JSON.stringify({
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: {
          raw: '{\n  "error": {\n    "message": "Invalid schema for function \'permissions_read\': schema must be a JSON Schema of \'type: \\"object\\"\', got \'type: \\"None\\"\'.",\n    "type": "invalid_request_error",\n    "param": "tools[21].function.parameters",\n    "code": "invalid_function_parameters"\n  }\n}',
          provider_name: "OpenAI",
          is_byok: false,
          provider_error_code: "invalid_function_parameters"
        }
      }
    }),
    "request_invalid"
  ],
  [
    "OpenRouter unknown model ID",
    400,
    '{"error":{"message":"openai/no-such-model-xyz is not a valid model ID","code":400}}',
    "model_unavailable"
  ],
  [
    "OpenRouter unknown key",
    401,
    '{"error":{"message":"User not found.","code":401}}',
    "provider_auth"
  ],
  [
    "upstream throttle relayed as a 400 that mentions the context window",
    400,
    JSON.stringify({
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: {
          raw: '{"error":{"message":"Rate limit on the context window pool"}}'
        }
      }
    }),
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
    `{"detail":"The 'gpt-6.1-sol-pro' model is not supported when using Codex with a ChatGPT account."}`,
    "model_unavailable"
  ],
  ["forbidden key", 403, '{"error":{"message":"Forbidden","code":403}}', "provider_auth"]
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
        metadata: {
          raw: "x".repeat(2000),
          error_type: "context_length_exceeded"
        }
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
            metadata: {
              raw: '{"error":{"message":"Daily token limit exceeded"}}'
            }
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
            metadata: {
              error_type: "context_length_exceeded",
              provider_code: "invalid_request"
            }
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
    missingOutput: (id) => ({
      kind: "output",
      id: `${id} (${MISSING_TOOL_OUTPUT})`
    }),
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
        [
          {
            items: [{ kind: "output", id: "x" }],
            deferWhileCallsPending: false
          }
        ],
        wire
      )
    ).toThrow("Stored test history contains output without matching function call x")
  })
})

describe("a connection that fails", () => {
  const request = {
    messages: [{ role: ROLE.user, content: "Hi" }],
    renderInteraction: () => "",
    model: "m",
    tools: [],
    deferredTools: [],
    toolChoice: "auto"
  } satisfies ModelProviderRequest
  const failure = async (provider: ModelProvider): Promise<unknown> => {
    try {
      for await (const _ of await provider.stream(request)) void _
    } catch (cause) {
      return cause
    }
    throw new Error("The request did not fail")
  }
  const refusedAt = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error(`connect ECONNREFUSED ${String(input)}`), {
        code: "ECONNREFUSED"
      })
    })
  }

  it("names the address and the cause on both wires, without credentials or a query", async () => {
    const chat = await failure(
      makeChatCompletionsProvider({
        providerId: "llama.cpp",
        baseUrl: "http://127.0.0.1:8080/v1?sig=zz9",
        auth: { headers: async () => ({ authorization: "Bearer sk-hidden" }) },
        fetch: refusedAt,
        maxAttempts: 1
      })
    )
    const responses = await failure(
      makeOpenAiResponsesProvider({
        baseUrl: "http://user:pw@127.0.0.1:8080/v1",
        auth: { headers: async () => ({ authorization: "Bearer sk-hidden" }) },
        fetch: refusedAt,
        maxAttempts: 1
      })
    )
    for (const cause of [chat, responses]) {
      expect(cause).toBeInstanceOf(ProviderError)
      expect(cause).toMatchObject({ code: "provider_unavailable" })
      const message = errorMessage(cause)
      expect(message).toContain("127.0.0.1:8080")
      expect(message).toContain("ECONNREFUSED")
      for (const secret of ["sig=zz9", "user:pw", "pw@", "sk-hidden"])
        expect(message).not.toContain(secret)
    }
  })
})
