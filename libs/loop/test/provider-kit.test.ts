import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  classifyRejection,
  httpRejection,
  MISSING_TOOL_OUTPUT,
  orderToolHistory,
  type ToolHistoryWire
} from "../src/providers/kit/index.js"

describe("rejection classification", () => {
  it("reads every target's wording into one taxonomy", () => {
    const answers: ReadonlyArray<readonly [string, number, string | undefined]> = [
      [
        "llama.cpp overflow",
        400,
        '{"error":{"code":400,"message":"request (6016 tokens) exceeds the available context size (4096 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":6016,"n_ctx":4096}}'
      ],
      [
        "llama.cpp unknown model",
        400,
        `{"error":{"code":400,"message":"model 'nope/missing-model' not found","type":"invalid_request_error"}}`
      ],
      [
        "llama.cpp bad request",
        400,
        `{"error":{"code":400,"message":"Expected 'messages' to be an array","type":"invalid_request_error"}}`
      ],
      [
        "llama.cpp loading",
        503,
        '{"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}'
      ],
      [
        "OpenRouter overflow",
        400,
        `{"error":{"message":"This endpoint's maximum context length is 8192 tokens. However, you requested about 9000 tokens.","code":400}}`
      ],
      [
        "Ollama overflow",
        500,
        '{"error":"prompt too long; exceeded max context length by 100 tokens"}'
      ],
      ["oversized body", 413, undefined],
      [
        "throttle that mentions tokens",
        429,
        '{"error":{"message":"Rate limit reached: too many tokens per minute"}}'
      ],
      ["bad key", 401, '{"error":{"message":"No auth credentials found","code":401}}'],
      ["teapot", 418, undefined]
    ]
    expect(
      Object.fromEntries(
        answers.map(([name, status, body]) => [
          name,
          classifyRejection(httpRejection(status, body), {})
        ])
      )
    ).toEqual({
      "llama.cpp overflow": "context_length_exceeded",
      "llama.cpp unknown model": "model_unavailable",
      "llama.cpp bad request": "request_invalid",
      "llama.cpp loading": "provider_unavailable",
      "OpenRouter overflow": "context_length_exceeded",
      "Ollama overflow": "context_length_exceeded",
      "oversized body": "context_length_exceeded",
      "throttle that mentions tokens": "rate_limited",
      "bad key": "provider_auth",
      teapot: "provider_error"
    })
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
