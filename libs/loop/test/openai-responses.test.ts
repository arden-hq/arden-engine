import { ROLE } from "@arden-hq/std/message-vocabulary"
import { describe, expect, it } from "vitest"
import { makeAgent } from "../src/index.js"

import type { ModelProviderRequest } from "../src/contracts/provider.js"
import { makeOpenAiResponsesProvider } from "../src/providers/openai-responses/provider.js"
import { collect, completionOf, recordOf, recordsOf } from "./kit.js"
import {
  baseRequest,
  makeTransport,
  simpleCompleted,
  sseResponse,
  staticAuth,
  toolCall
} from "./openai-responses-kit.js"

describe("OpenAI Responses provider", () => {
  it("maps deltas, function-call args, and usage without double-counting cache reads or writes", async () => {
    const transport = makeTransport([
      () =>
        sseResponse((control) => {
          control.send({
            type: "response.reasoning_summary_text.delta",
            output_index: 0,
            delta: "Thin"
          })
          control.send({
            type: "response.reasoning_text.delta",
            output_index: 0,
            delta: "king."
          })
          control.send({
            type: "response.output_item.added",
            output_index: 1,
            item: {
              type: "function_call",
              id: "fc-1",
              call_id: "call-1",
              name: "weather",
              arguments: "",
              status: "in_progress"
            }
          })
          control.send({
            type: "response.function_call_arguments.delta",
            output_index: 1,
            delta: '{"city":'
          })
          control.send({
            type: "response.function_call_arguments.delta",
            output_index: 1,
            delta: '"Yerevan"}'
          })
          control.send({
            type: "response.function_call_arguments.done",
            output_index: 1,
            name: "weather"
          })
          control.send({
            type: "response.output_text.delta",
            output_index: 2,
            delta: "Do"
          })
          control.send({
            type: "response.refusal.delta",
            output_index: 2,
            delta: "ne."
          })
          control.send({
            type: "response.completed",
            response: {
              id: "resp-map",
              output: [
                {
                  type: "function_call",
                  id: "fc-1",
                  call_id: "call-1",
                  name: "weather",
                  arguments: '{"city":"Yerevan"}',
                  status: "completed"
                },
                {
                  id: "msg-map",
                  type: "message",
                  role: ROLE.assistant,
                  content: [{ type: "output_text", text: "Done." }],
                  status: "completed"
                }
              ],
              usage: {
                input_tokens: 20,
                input_tokens_details: {
                  cached_tokens: 8,
                  cache_write_tokens: 4
                },
                output_tokens: 5
              }
            }
          })
          control.end()
        })
    ])

    const provider = makeOpenAiResponsesProvider({
      auth: staticAuth,
      fetch: transport.fetchImpl
    })
    const items = await collect(provider.stream(baseRequest))

    expect(transport.requests[0]?.headers).toMatchObject({
      authorization: "Bearer token-1"
    })
    const deltas = (tag: "ReasoningDelta" | "TextDelta") =>
      items.flatMap((item) => (item._tag === tag ? [item.content] : []))
    expect(deltas("ReasoningDelta").join("")).toBe("Thinking.")
    expect(deltas("TextDelta").join("")).toBe("Done.")
    expect(
      items
        .flatMap((item) => (item._tag === "ToolCallDelta" ? [item.arguments_delta ?? ""] : []))
        .join("")
    ).toBe('{"city":"Yerevan"}')
    const final = completionOf(items)
    expect(final.usage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 5,
      cache_read_tokens: 8,
      cache_write_tokens: 4
    })
    expect(final.finish_reason).toBe("tool_calls")
    expect(final.message.tool_calls).toEqual([
      {
        id: "call-1",
        type: "function",
        function: { name: "weather", arguments: '{"city":"Yerevan"}' }
      }
    ])
    expect(final.message.content).toBe("Done.")
  })

  it("reports no spend for a Codex response, so a run's cost stays unknown, not 0", async () => {
    const transport = makeTransport([
      () =>
        sseResponse((control) => {
          control.send({
            type: "response.completed",
            response: simpleCompleted
          })
          control.end()
        })
    ])
    const provider = makeOpenAiResponsesProvider({
      auth: staticAuth,
      fetch: transport.fetchImpl
    })
    const result = await makeAgent(
      { model: "gpt-5.4" },
      {
        provider,
        toolset: {
          entries: () => [],
          loadedNames: () => new Set(),
          load: () => {},
          execute: () => ({ content: "", preview: "" })
        }
      }
    ).run([{ role: ROLE.user, content: "Hi." }])
    expect(result.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost: undefined
    })
    expect(result.cost).toBe(0)
  })

  it("carries the spend a Responses route reports in usage, as OpenRouter's Responses API does", async () => {
    const transport = makeTransport([
      () =>
        sseResponse((control) => {
          control.send({
            type: "response.completed",
            response: {
              ...simpleCompleted,
              usage: { ...simpleCompleted.usage, cost: 0.0007 }
            }
          })
          control.end()
        })
    ])
    const provider = makeOpenAiResponsesProvider({
      auth: staticAuth,
      fetch: transport.fetchImpl
    })
    expect(completionOf(await collect(provider.stream(baseRequest))).usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost: 0.0007
    })
  })

  it("hands a tool its arguments without the citation markers a model wrote into them", async () => {
    const cited =
      '{"message":"Verified: Sep 7 2026. \uE200cite\uE202turn654819fetch1\uE202turn909470fetch0\uE201"}'
    const transport = makeTransport([
      () =>
        sseResponse((control) => {
          control.send({
            type: "response.completed",
            response: {
              id: "resp-cite",
              output: [
                {
                  type: "function_call",
                  id: "fc-1",
                  call_id: "call-1",
                  name: "agent_message",
                  arguments: cited,
                  status: "completed"
                }
              ],
              usage: {
                input_tokens: 3,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: 2
              }
            }
          })
          control.end()
        })
    ])
    const provider = makeOpenAiResponsesProvider({
      auth: staticAuth,
      fetch: transport.fetchImpl
    })
    const final = completionOf(await collect(provider.stream(baseRequest)))
    expect(final.message.tool_calls).toEqual([
      {
        id: "call-1",
        type: "function",
        function: {
          name: "agent_message",
          arguments: '{"message":"Verified: Sep 7 2026. "}'
        }
      }
    ])
  })

  it("retries a pre-emission 401 exactly once with forceRefresh, then fails closed", async () => {
    const unauthorized = () =>
      new Response(JSON.stringify({ error: { message: "expired" } }), {
        status: 401,
        headers: { "content-type": "application/json" }
      })
    const transport = makeTransport([unauthorized, unauthorized])

    const provider = makeOpenAiResponsesProvider({
      fetch: transport.fetchImpl,
      auth: {
        headers: async ({ forceRefresh }) => ({
          authorization: forceRefresh === true ? "Bearer refreshed" : "Bearer stale"
        })
      }
    })

    await expect(collect(provider.stream(baseRequest))).rejects.toMatchObject({
      code: "provider_auth"
    })
    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[0]?.headers).toMatchObject({
      authorization: "Bearer stale"
    })
    expect(transport.requests[1]?.headers).toMatchObject({
      authorization: "Bearer refreshed"
    })
  })

  it("retries a post-emission transport failure, yielding ProviderStreamRetry with attempt/delay before re-streaming", async () => {
    const transport = makeTransport([
      () =>
        sseResponse((control) => {
          control.send({
            type: "response.output_text.delta",
            output_index: 0,
            delta: "Partial"
          })
          setTimeout(() => control.destroy(), 5)
        }),
      () =>
        sseResponse((control) => {
          control.send({
            type: "response.completed",
            response: simpleCompleted
          })
          control.end()
        })
    ])

    const provider = makeOpenAiResponsesProvider({
      auth: staticAuth,
      fetch: transport.fetchImpl
    })
    const items = await collect(provider.stream(baseRequest))

    expect(transport.requests).toHaveLength(2)
    expect(items[0]).toEqual({ _tag: "TextDelta", content: "Partial" })
    expect(items[1]).toEqual({
      _tag: "ProviderStreamRetry",
      attempt: 1,
      maxAttempts: expect.any(Number),
      delayMs: expect.any(Number),
      reason: expect.any(String)
    })
    expect(completionOf(items).message.content).toBe("Recovered.")
  })

  it("does not retry known terminal response failures", async () => {
    const transport = makeTransport([
      () =>
        sseResponse((control) => {
          control.send({
            type: "response.failed",
            response: {
              error: {
                code: "context_length_exceeded",
                message: "Your input exceeds the context window."
              }
            }
          })
          control.end()
        })
    ])

    const provider = makeOpenAiResponsesProvider({
      auth: staticAuth,
      fetch: transport.fetchImpl,
      maxAttempts: 2
    })

    await expect(collect(provider.stream(baseRequest))).rejects.toMatchObject({
      code: "context_length_exceeded"
    })
    expect(transport.requests).toHaveLength(1)
  })

  it("puts developer context and user steering after the tool outputs of the calls they interrupt", async () => {
    const transport = makeTransport([
      () =>
        sseResponse((control) => {
          control.send({
            type: "response.completed",
            response: simpleCompleted
          })
          control.end()
        })
    ])
    const provider = makeOpenAiResponsesProvider({
      auth: staticAuth,
      fetch: transport.fetchImpl
    })
    const request: ModelProviderRequest = {
      ...baseRequest,
      messages: [
        { role: ROLE.user, content: "Check both." },
        {
          role: ROLE.assistant,
          content: "",
          tool_calls: [toolCall("call-first"), toolCall("call-second")]
        },
        {
          role: ROLE.tool,
          tool_call_id: "call-first",
          content: "First output"
        },
        { role: ROLE.developer, content: "Current run context" },
        {
          role: ROLE.user,
          client_id: "tool-media:call-first",
          content: "Ordinary user text"
        },
        {
          role: ROLE.tool,
          tool_call_id: "call-second",
          content: "Second output"
        }
      ]
    }

    await collect(provider.stream(request))
    const input = recordsOf(recordOf(transport.requests[0]?.body).input)
    expect(input.slice(-4)).toEqual([
      {
        type: "function_call_output",
        call_id: "call-first",
        output: "First output",
        status: "completed"
      },
      {
        type: "function_call_output",
        call_id: "call-second",
        output: "Second output",
        status: "completed"
      },
      {
        type: "message",
        role: ROLE.developer,
        content: [{ type: "input_text", text: "Current run context" }]
      },
      { role: ROLE.user, content: "Ordinary user text" }
    ])
  })
})
