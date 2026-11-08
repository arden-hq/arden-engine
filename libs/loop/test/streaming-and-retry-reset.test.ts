import { describe, expect, it } from "vitest"

import { runModelTurn } from "../src/agent/model-turn.js"
import { renderInteraction } from "../src/agent/interactions.js"
import type { AssistantOutputPart, ChatMessage } from "../src/contracts/messages.js"
import type { ToolMeta } from "../src/contracts/tools.js"
import type { ModelProviderRequest, ModelStreamItem } from "../src/contracts/provider.js"
import type { AgentEvent } from "../src/contracts/events.js"
import { deferred, firstTagged, tagged } from "./kit.js"

const userMessage = (content = "hello"): ChatMessage => ({ role: "user", content })

const response = (
  options: {
    content?: string | null
    finishReason?: "stop" | "tool_calls"
    reasoning?: string | null
    toolCalls?: ReadonlyArray<{ id: string; name: string; arguments: string }>
    providerCalls?: ReadonlyArray<{
      id: string
      name: string
      arguments: Readonly<Record<string, never>>
      result: string
    }>
    outputParts?: ReadonlyArray<AssistantOutputPart>
  } = {}
) => ({
  model: "fixture-model",
  _tag: "Completed" as const,
  message: {
    role: "assistant" as const,
    content: options.content ?? null,
    tool_calls: (options.toolCalls ?? []).map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: call.arguments }
    })),
    reasoning_content: options.reasoning ?? null,
    ...(options.providerCalls === undefined ? {} : { provider_tool_calls: options.providerCalls }),
    ...(options.outputParts === undefined ? {} : { output_parts: options.outputParts })
  },
  finish_reason: options.finishReason ?? ("stop" as const),
  usage: { prompt_tokens: 3, completion_tokens: 2 }
})

const run = (
  items: Iterable<ModelStreamItem> | AsyncIterable<ModelStreamItem>,
  options: {
    metas?: ReadonlyMap<string, ToolMeta>
    now?: () => number
    signal?: AbortSignal
  } = {}
) => {
  const events: AgentEvent[] = []
  const history: ChatMessage[] = [userMessage()]
  const request: ModelProviderRequest = {
    messages: history,
    renderInteraction,
    model: "fixture-model",
    tools: [],
    deferredTools: [],
    toolChoice: "auto",
    ...(options.signal === undefined ? {} : { signal: options.signal })
  }
  const promise = runModelTurn({
    provider: { protocolVersion: 1, stream: () => items },
    request,
    history,
    metas: options.metas ?? new Map(),
    ...(options.now === undefined ? {} : { now: options.now }),
    emit: async (event) => {
      events.push(event)
    }
  })
  return { promise, events, history }
}

describe("streaming projection and provider retry reset", () => {
  it("settles a completed hosted fragment before subsequent text, exactly once", async () => {
    const call = { id: "search-1", name: "web_search", arguments: {}, result: "found", done: true }
    let clock = 100
    const harness = run(
      [
        { _tag: "ProviderToolCall", call: { ...call, done: false } },
        { _tag: "OutputItemReady", message: response({ providerCalls: [call] }).message },
        { _tag: "TextDelta", content: "answer" },
        { _tag: "OutputItemReady", message: response({ content: "answer" }).message },
        response({ content: "answer", providerCalls: [call] })
      ],
      {
        now: () => {
          const value = clock
          clock += 25
          return value
        }
      }
    )
    await harness.promise
    const completions = tagged(harness.events, "ToolCompleted")
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ tool_id: call.id, result: "found" })
    expect(harness.events.findIndex((event) => event._tag === "ToolCompleted")).toBeLessThan(
      harness.events.findIndex((event) => event._tag === "TextDelta")
    )
  })

  it("projects the text delta lifecycle with canonical TextEnded content", async () => {
    const harness = run([
      { _tag: "TextDelta", content: "hello" },
      { _tag: "TextDelta", content: " world" },
      response({ content: "hello world" })
    ])
    const output = await harness.promise
    expect(harness.events.map((event) => event._tag)).toEqual([
      "TextStarted",
      "TextDelta",
      "TextDelta",
      "TextEnded"
    ])
    expect(harness.events.every((event) => event.depth === 0 && event.parent_id === null)).toBe(
      true
    )
    expect(
      harness.events.flatMap((event) => (event._tag === "TextDelta" ? [event.content] : []))
    ).toEqual(["hello", " world"])
    expect(firstTagged(harness.events, "TextEnded").content).toBe("hello world")
    expect(output.lastTextId).toBe(firstTagged(harness.events, "TextStarted").message_id)
    expect(harness.history).toHaveLength(2)
    expect(harness.history[1]).toMatchObject({ role: "assistant", content: "hello world" })
    expect(harness.history[1]).toMatchObject({
      output_parts: [{ type: "text", text: "hello world" }]
    })
  })

  it("buffers tool input until id and name are known, then flushes and persists the call", async () => {
    const call = { id: "call-1", name: "echo", arguments: '{"value":1}' }
    const harness = run(
      [
        { _tag: "TextDelta", content: "before" },
        {
          _tag: "ToolCallDelta",
          index: 0,
          tool_id: "call-1",
          name: "echo",
          arguments_delta: '{"value":',
          done: false
        },
        { _tag: "ToolCallDelta", index: 0, arguments_delta: "1}", done: true },
        response({ content: "before", finishReason: "tool_calls", toolCalls: [call] })
      ],
      {
        metas: new Map([["echo", { name: "echo", host: { display_name: "Echo" } }]])
      }
    )
    const output = await harness.promise
    expect(harness.events.map((event) => event._tag)).toEqual([
      "TextStarted",
      "TextDelta",
      "TextEnded",
      "ToolInputStarted",
      "ToolInputDelta",
      "ToolInputDelta",
      "ToolInputEnded"
    ])
    expect(harness.events.find((event) => event._tag === "ToolInputStarted")).toMatchObject({
      tool_id: "call-1",
      name: "echo",
      host: { display_name: "Echo" }
    })
    expect(
      harness.events.flatMap((event) => (event._tag === "ToolInputDelta" ? [event.delta] : []))
    ).toEqual(['{"value":', "1}"])
    expect(output.streamedToolInputIds).toEqual(new Set(["call-1"]))
    expect(harness.history[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "echo", arguments: '{"value":1}' } }
      ],
      output_parts: [
        { type: "text", text: "before" },
        { type: "tool_call", tool_call_id: "call-1", execution: "runtime" }
      ]
    })
  })

  it("resets every partially streamed id on ProviderStreamRetry and restarts with fresh ids", async () => {
    const harness = run([
      { _tag: "TextDelta", content: "discarded" },
      { _tag: "ReasoningDelta", content: "old reasoning" },
      { _tag: "ToolCallDelta", index: 0, tool_id: "old-call", name: "old", arguments_delta: "{}" },
      { _tag: "ProviderStreamRetry", attempt: 1, maxAttempts: 5 },
      { _tag: "TextDelta", content: "kept" },
      response({ content: "kept" })
    ])
    await harness.promise
    const reset = firstTagged(harness.events, "ModelResponseReset")
    expect(reset.message_ids).toHaveLength(2)
    expect(reset.tool_call_ids).toEqual(["old-call"])
    const [discardedStart, freshStart, ...extraStarts] = tagged(harness.events, "TextStarted")
    expect(extraStarts).toEqual([])
    expect(discardedStart?.message_id).not.toBe(freshStart?.message_id)
    expect(reset.message_ids).toContain(discardedStart?.message_id)
    expect(
      harness.events.flatMap((event) => (event._tag === "TextDelta" ? [event.content] : []))
    ).toEqual(["discarded", "kept"])
    expect(harness.history[1]).toMatchObject({ content: "kept" })
  })

  it("closes interrupted reasoning under its original id without persisting a partial fragment", async () => {
    const waiting = deferred()
    const controller = new AbortController()
    const harness = run(
      (async function* (): AsyncIterable<ModelStreamItem> {
        yield { _tag: "ReasoningDelta", content: "Partial." }
        waiting.resolve()
        await new Promise(() => undefined)
      })(),
      { signal: controller.signal }
    )
    await waiting.promise
    controller.abort()
    await expect(harness.promise).rejects.toMatchObject({ name: "AbortError" })
    const start = firstTagged(harness.events, "ReasoningStarted")
    expect(tagged(harness.events, "ReasoningEnded")).toEqual([
      { _tag: "ReasoningEnded", depth: 0, parent_id: null, message_id: start.message_id }
    ])
    expect(harness.history).toEqual([userMessage()])
  })
})
