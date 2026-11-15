import { describe, expect, it } from "vitest"

import {
  makeAgent,
  providerErrorCode,
  type ModelProvider,
  type ModelProviderRequest,
  type ModelRequestMiddleware,
  type ModelStreamItem
} from "../src/index.js"
import { makeChatCompletionsProvider } from "../src/providers/chat-completions/provider.js"
import { SemanticResponseError } from "../src/providers/kit/errors.js"
import { makeOpenAiResponsesProvider } from "../src/providers/openai-responses/provider.js"
import { scriptedProvider } from "./kit.js"

const response = (content: string, finishReason: "stop" | "length" = "stop") => ({
  model: "test-model",
  _tag: "Completed" as const,
  message: {
    role: "assistant" as const,
    content,
    tool_calls: [],
    reasoning_content: null
  },
  finish_reason: finishReason,
  usage: { prompt_tokens: 9, completion_tokens: 1 }
})

const emptyToolset = {
  entries: () => [],
  loadedNames: () => new Set<string>(),
  load: () => undefined,
  execute: () => ({ content: "", preview: "" })
}

const contents = (request: ModelProviderRequest | undefined) =>
  (request?.messages ?? []).map((message) => message.content)

/** A provider that refuses its first request as too long and answers every later one. */
const overflowingOnce = (): {
  readonly requests: Array<ModelProviderRequest>
  readonly shape: ModelProvider
} => {
  const requests: Array<ModelProviderRequest> = []
  return {
    requests,
    shape: {
      protocolVersion: 1,
      stream: (request): ReadonlyArray<ModelStreamItem> => {
        requests.push(request)
        if (requests.length === 1)
          throw new SemanticResponseError("input exceeds the window", "context_length_exceeded")
        return [response("done")]
      }
    }
  }
}

describe("a reply cut off at the output limit", () => {
  it("continues the run with one meta message and ends on the next full reply", async () => {
    const model = scriptedProvider([[response("part one", "length")], [response("part two")]])
    const agent = makeAgent(
      { model: "test-model" },
      { provider: model.shape, toolset: emptyToolset }
    )

    const result = await agent.run([{ role: "user", content: "write a lot" }])

    expect(result.stop_reason).toBe("end_turn")
    expect(result.text).toBe("part two")
    expect(model.requests).toHaveLength(2)
    expect(contents(model.requests[1]).slice(-3)).toEqual([
      "write a lot",
      "part one",
      "Your last reply was cut off at the output token limit. Continue from where it stopped " +
        "and do not repeat what you already wrote. Split the remaining work into smaller steps."
    ])
  })

  it("stops with max_output_length after two continuations in a row", async () => {
    const model = scriptedProvider([
      [response("one", "length")],
      [response("two", "length")],
      [response("three", "length")]
    ])
    const agent = makeAgent(
      { model: "test-model" },
      { provider: model.shape, toolset: emptyToolset }
    )

    const result = await agent.run([{ role: "user", content: "write a lot" }])

    expect(result.stop_reason).toBe("max_output_length")
    expect(result.text).toBe("three")
    expect(model.requests).toHaveLength(3)
  })
})

describe("a request the provider refuses as too long", () => {
  it("is sent again once a middleware shortens the history in answer", async () => {
    const model = overflowingOnce()
    const overflowSeen: Array<boolean> = []
    const shorten: ModelRequestMiddleware = async (request, next) => {
      const prepared = await next(request)
      overflowSeen.push(prepared.contextOverflow === true)
      if (prepared.contextOverflow !== true) return prepared
      const { contextOverflow: _, ...answered } = prepared
      const messages = [{ role: "user" as const, content: "summary of the long chat" }]
      return { ...answered, messages, compactionReplacement: messages }
    }
    const mintedTurns: Array<number> = []
    const agent = makeAgent(
      {
        model: "test-model",
        modelRequestMiddlewares: [shorten],
        mintMessageId: (kind, position) => {
          mintedTurns.push(position.turn)
          return `${kind}-${position.turn}-${position.fragment}-${position.index}`
        }
      },
      { provider: model.shape, toolset: emptyToolset }
    )

    const result = await agent.run([
      { role: "user", content: "a very long chat" },
      { role: "assistant", content: "a very long answer" },
      { role: "user", content: "go on" }
    ])

    expect(overflowSeen).toEqual([false, true])
    expect(new Set(mintedTurns)).toEqual(new Set([0]))
    expect(result.stop_reason).toBe("end_turn")
    expect(result.text).toBe("done")
    expect(model.requests).toHaveLength(2)
    expect(contents(model.requests[1])).toEqual(["summary of the long chat"])
    expect(result.messages.map((message) => message.content)).toEqual([
      "summary of the long chat",
      "done"
    ])
  })

  it("fails the run with the refusal when no middleware shortens the history", async () => {
    const model = overflowingOnce()
    const agent = makeAgent(
      { model: "test-model" },
      { provider: model.shape, toolset: emptyToolset }
    )

    const failure = await agent.run([{ role: "user", content: "a very long chat" }]).then(
      () => undefined,
      (cause: unknown) => cause
    )

    expect(providerErrorCode(failure)).toBe("context_length_exceeded")
    expect(model.requests).toHaveLength(1)
  })
})

describe("a call the output limit cut off after it was announced", () => {
  const weatherToolset = {
    entries: () => [{ description: "weather", parameters: {}, meta: { name: "weather" } }],
    loadedNames: () => new Set<string>(),
    load: () => undefined,
    execute: () => ({ content: "ok", preview: "ok" })
  }

  /** The tool-input events of a run, and the calls it announced but never ended or retracted. */
  const toolInputs = async (provider: ModelProvider) => {
    const resets: Array<unknown> = []
    const started: Array<string> = []
    const settled = new Set<string>()
    const stream = makeAgent(
      { model: "test-model", maxIterations: 2 },
      { provider, toolset: weatherToolset }
    ).stream([{ role: "user", content: "Weather?" }])
    let text: string | undefined
    for await (const event of stream) {
      if (!("_tag" in event)) {
        text = event.text
        continue
      }
      if (event._tag === "ToolInputStarted") started.push(event.tool_id)
      if (event._tag === "ToolInputEnded") settled.add(event.tool_id)
      if (event._tag === "ModelResponseReset") {
        resets.push({ message_ids: event.message_ids, tool_call_ids: event.tool_call_ids })
        event.tool_call_ids.forEach((id) => settled.add(id))
      }
    }
    return { resets, unsettled: started.filter((id) => !settled.has(id)), text }
  }

  const sse = (events: ReadonlyArray<unknown>) =>
    new Response(
      events
        .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
        .join(""),
      {
        headers: { "content-type": "text/event-stream" }
      }
    )
  const chunk = (delta: unknown, finish: string | null = null) => ({
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finish }]
  })
  const fetchOf =
    (answers: ReadonlyArray<Response>): typeof fetch =>
    async () => {
      const next = answers[calls++]
      if (next === undefined) throw new Error("unexpected request")
      return next
    }
  let calls = 0

  it("is retracted alone, the same way on the Chat Completions and Responses wires", async () => {
    calls = 0
    const chatCompletions = await toolInputs(
      makeChatCompletionsProvider({
        providerId: "llama.cpp",
        baseUrl: "http://127.0.0.1:1/v1",
        fetch: fetchOf([
          sse([
            chunk({
              tool_calls: [
                { index: 0, id: "whole", function: { name: "weather", arguments: '{"c":1}' } }
              ]
            }),
            chunk({ tool_calls: [{ index: 1, id: "cut", function: { name: "weather" } }] }),
            chunk({ tool_calls: [{ index: 1, function: { arguments: '{"c' } }] }),
            // Cut before its name arrived: never announced, dropped like any cut call.
            chunk({ tool_calls: [{ index: 2, id: "nameless", function: { arguments: "" } }] }),
            chunk({}, "length"),
            "[DONE]"
          ]),
          sse([chunk({ content: "Sunny." }), chunk({}, "stop"), "[DONE]"])
        ])
      })
    )
    calls = 0
    const whole = {
      id: "w",
      type: "function_call",
      call_id: "whole",
      name: "weather",
      arguments: '{"c":1}',
      status: "completed"
    }
    const cut = { ...whole, id: "p", call_id: "cut", arguments: "", status: "in_progress" }
    const responses = await toolInputs(
      makeOpenAiResponsesProvider({
        auth: { headers: async () => ({}) },
        fetch: fetchOf([
          sse([
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...whole, arguments: "" }
            },
            { type: "response.output_item.done", output_index: 0, item: whole },
            { type: "response.output_item.added", output_index: 1, item: cut },
            { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"c' },
            {
              type: "response.incomplete",
              response: {
                output: [whole, { ...cut, arguments: '{"c' }],
                incomplete_details: { reason: "max_output_tokens" }
              }
            }
          ]),
          sse([
            {
              type: "response.completed",
              response: {
                id: "r2",
                output: [
                  {
                    id: "m",
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "Sunny." }]
                  }
                ]
              }
            }
          ])
        ])
      })
    )
    const expected = {
      resets: [{ message_ids: [], tool_call_ids: ["cut"] }],
      unsettled: [],
      text: "Sunny."
    }
    expect(chatCompletions).toEqual(expected)
    expect(responses).toEqual(expected)
  })
})
