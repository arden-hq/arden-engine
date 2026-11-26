import { ROLE } from "@arden-hq/std/message-vocabulary"
import { describe, expect, it } from "vitest"

import { collect, completionOf, recordOf, sseResponse } from "./kit.js"
import {
  GEMMA,
  SHELL_LOADED,
  answered,
  call,
  llamaChunk,
  llamaUsage,
  provider,
  request,
  searchChunk,
  searchRequest,
  searchTool,
  weather,
  wire
} from "./chat-completions-kit.js"

describe("Chat Completions client tool search", () => {
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
          llamaChunk({ role: ROLE.assistant, content: null }),
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
          role: ROLE.assistant,
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
          origin: {
            provider: "llama.cpp",
            api: "chat-completions",
            model: GEMMA,
            requested_model: GEMMA
          }
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
      role: ROLE.assistant,
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
      origin: {
        provider: "llama.cpp",
        api: "chat-completions",
        model: GEMMA,
        requested_model: GEMMA
      }
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

    expect(calls).toEqual([
      [
        {
          id: "bad1",
          name: "tool_search",
          arguments: {},
          result: expect.stringMatching(/\S/),
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
          result: expect.stringMatching(/\S/),
          done: true,
          loaded_tool_names: [],
          source_refs: []
        }
      ]
    ])
  })
})
