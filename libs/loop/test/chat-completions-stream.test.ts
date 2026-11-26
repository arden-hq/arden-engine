import { ROLE } from "@arden-hq/std/message-vocabulary"
import { describe, expect, it } from "vitest"

import { collect, completionOf, recordOf, sseResponse } from "./kit.js"
import {
  GEMMA,
  answered,
  call,
  llamaChunk,
  llamaUsage,
  provider,
  request,
  weather
} from "./chat-completions-kit.js"

describe("Chat Completions stream mapping", () => {
  it("maps llama.cpp reasoning, text, two parallel calls and cached usage", async () => {
    const { provider: cc, transport } = provider([
      () =>
        sseResponse([
          llamaChunk({ role: ROLE.assistant, content: null }),
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
          role: ROLE.assistant,
          content: "Checking both.",
          tool_calls: [call("Z7zb"), call("gQg6", "Rome")],
          reasoning_content: "Two cities.",
          output_parts: [
            { type: "reasoning", text: "Two cities." },
            { type: "text", text: "Checking both." },
            { type: "tool_call", tool_call_id: "Z7zb", execution: "runtime" },
            { type: "tool_call", tool_call_id: "gQg6", execution: "runtime" }
          ],
          origin: {
            provider: "llama.cpp",
            api: "chat-completions",
            model: GEMMA,
            requested_model: GEMMA
          }
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
          role: ROLE.assistant,
          content: null,
          tool_calls: [call("whole")],
          reasoning_content: null,
          output_parts: [{ type: "tool_call", tool_call_id: "whole", execution: "runtime" }],
          origin: {
            provider: "llama.cpp",
            api: "chat-completions",
            model: GEMMA,
            requested_model: GEMMA
          }
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
