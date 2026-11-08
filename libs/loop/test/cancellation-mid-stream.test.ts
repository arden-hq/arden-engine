import { describe, expect, it } from "vitest"

import {
  makeAgent,
  type AgentStreamEvent,
  type ChatMessage,
  type ModelProviderRequest,
  type ToolCallRequest,
  type ToolEntry,
  type Toolset
} from "../src/index.js"
import { deferred } from "./kit.js"

const response = (
  options: {
    content?: string | null
    finishReason?: "stop" | "tool_calls"
    toolCalls?: ReadonlyArray<{ id: string; name: string }>
  } = {}
) => ({
  model: "test-model",
  _tag: "Completed" as const,
  message: {
    role: "assistant" as const,
    content: options.content ?? null,
    tool_calls: (options.toolCalls ?? []).map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: "{}" }
    })),
    reasoning_content: null
  },
  finish_reason: options.finishReason ?? ("stop" as const),
  usage: { prompt_tokens: 1, completion_tokens: 1 }
})

const tool = (name: string): ToolEntry => ({
  description: name,
  parameters: { type: "object", properties: {} },
  meta: { name, host: { display_name: name } }
})

describe("cancellation mid-stream", () => {
  it("aborts an in-flight provider: AbortError, aborted req.signal, onFinish still runs", async () => {
    const started = deferred()
    let providerSignal: AbortSignal | undefined
    const provider = {
      protocolVersion: 1 as const,
      stream: ({ signal }: ModelProviderRequest) => {
        providerSignal = signal
        started.resolve()
        return (async function* () {
          yield { _tag: "TextDelta" as const, content: "partial" }
          await new Promise(() => undefined)
        })()
      }
    }
    let finishes = 0
    const agent = makeAgent(
      { model: "test-model" },
      {
        provider,
        toolset: {
          entries: () => [],
          loadedNames: () => new Set<string>(),
          load: () => undefined,
          execute: () => ({ content: "unused", preview: "unused" })
        },
        hooks: {
          onFinish: () => {
            finishes += 1
          }
        }
      }
    )
    const controller = new AbortController()
    const run = agent.run([{ role: "user", content: "hello" }], { signal: controller.signal })
    await started.promise
    controller.abort()

    await expect(run).rejects.toMatchObject({ name: "AbortError" })
    expect(providerSignal?.aborted).toBe(true)
    expect(finishes).toBe(1)
  })

  it("never executes queued calls after cancellation when the active call releases its locks", async () => {
    const started = deferred()
    const release = deferred()
    const executed: string[] = []
    let activeSignal: AbortSignal | undefined
    const agent = makeAgent(
      { model: "test-model", maxToolConcurrency: 2 },
      {
        provider: {
          protocolVersion: 1,
          stream: () => [
            response({
              finishReason: "tool_calls",
              toolCalls: [
                { id: "active", name: "write" },
                { id: "group_waiter", name: "write" },
                { id: "permit_waiter", name: "write" }
              ]
            })
          ]
        },
        toolset: {
          entries: () => [{ ...tool("write"), meta: { name: "write", changes_state: true } }],
          loadedNames: () => new Set(),
          load: () => {},
          execute: async (request) => {
            executed.push(request.toolCallId)
            activeSignal = request.signal
            started.resolve()
            await release.promise
            return { content: "finished", preview: "finished" }
          }
        }
      }
    )
    const controller = new AbortController()
    const running = agent.run([{ role: "user", content: "go" }], { signal: controller.signal })
    await started.promise
    controller.abort()
    try {
      await expect(running).rejects.toMatchObject({ name: "AbortError" })
      expect(activeSignal?.aborted).toBe(true)
    } finally {
      release.resolve()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(executed).toEqual(["active"])
  })

  it("settles an interrupted tool batch as cancelled, classifying by signal not error type", async () => {
    const started = deferred()
    let startedCount = 0
    const toolset: Toolset = {
      entries: () => [tool("throws_on_abort"), tool("hangs")],
      loadedNames: () => new Set<string>(),
      load: () => undefined,
      execute: (request: ToolCallRequest) => {
        startedCount += 1
        if (startedCount === 2) started.resolve()
        if (request.name === "throws_on_abort") {
          return new Promise((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => reject(new Error("boom")), {
              once: true
            })
          })
        }
        return new Promise(() => undefined)
      }
    }
    let finishMessages: ReadonlyArray<ChatMessage> = []
    let finishes = 0
    const agent = makeAgent(
      { model: "test-model" },
      {
        provider: {
          protocolVersion: 1 as const,
          stream: () => [
            response({
              finishReason: "tool_calls",
              toolCalls: [
                { id: "t1", name: "throws_on_abort" },
                { id: "t2", name: "hangs" }
              ]
            })
          ]
        },
        toolset,
        hooks: {
          onFinish: (_text, _steps, messages) => {
            finishes += 1
            finishMessages = messages
          }
        }
      }
    )

    const controller = new AbortController()
    const events: AgentStreamEvent[] = []
    const consume = (async () => {
      for await (const event of agent.stream([{ role: "user", content: "go" }], {
        signal: controller.signal
      })) {
        events.push(event)
      }
    })()
    await started.promise
    controller.abort()
    await expect(consume).rejects.toMatchObject({ name: "AbortError" })

    expect(finishes).toBe(1)
    for (const id of ["t1", "t2"]) {
      expect(finishMessages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: id,
          content: "Tool call cancelled."
        })
      )
    }
    expect(events.some((event) => "_tag" in event && event._tag === "ToolCompleted")).toBe(false)
    expect(
      events.filter((event) => "_tag" in event && event._tag === "ToolInputStarted")
    ).toHaveLength(2)
  })
})
