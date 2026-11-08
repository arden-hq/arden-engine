import { describe, expect, it } from "vitest"

import {
  makeAgent,
  type ChatMessage,
  type ToolCallRequest,
  type ToolEntry,
  type ToolResult,
  type Toolset
} from "../src/index.js"
import { scriptedProvider } from "./kit.js"

const response = (
  options: {
    content?: string | null
    finishReason?: "stop" | "tool_calls"
    toolCalls?: ReadonlyArray<{ id: string; name: string; arguments?: string }>
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
      function: { name: call.name, arguments: call.arguments ?? "{}" }
    })),
    reasoning_content: null
  },
  finish_reason: options.finishReason ?? ("stop" as const),
  usage: { prompt_tokens: 1, completion_tokens: 1 }
})

const tool = (
  name: string,
  options: { endsTurn?: boolean; deferred?: boolean } = {}
): ToolEntry => ({
  description: name,
  parameters: { type: "object", properties: {} },
  meta: {
    name,
    ends_turn: options.endsTurn ?? false,
    deferred: options.deferred ?? false,
    host: { display_name: name }
  }
})

const toolset = (
  entries: ReadonlyArray<ToolEntry>,
  behavior: (request: ToolCallRequest) => ToolResult | Promise<ToolResult>
) => {
  const calls: ToolCallRequest[] = []
  const loaded = new Set<string>()
  const shape: Toolset = {
    entries: () => entries,
    loadedNames: () => new Set(loaded),
    load: (names) => {
      for (const name of names) loaded.add(name)
    },
    execute: (request) => {
      calls.push(request)
      return behavior(request)
    }
  }
  return { shape, calls, loaded }
}

describe("pause and durable recovery", () => {
  it("replays recovered results and terminates on a recovered ends_turn success at step 1", async () => {
    const model = scriptedProvider([])
    const tools = toolset([tool("first"), tool("finish", { endsTurn: true })], () => {
      throw new Error("must not execute recovered calls")
    })
    const recoveredContext = {
      type: "context" as const,
      content_type: "recovery_guidance",
      content: "fixture context",
      metadata: { source: "test" }
    }
    const decorated: Toolset = {
      ...tools.shape,
      decorateResult: (request, result) =>
        request.name === "finish" ? { ...result, model_content: [recoveredContext] } : result
    }
    const recoverRequests: string[][] = []
    const agent = makeAgent(
      { model: "test-model" },
      {
        provider: model.shape,
        toolset: decorated,
        hooks: {
          recoverToolCalls: (calls) => {
            recoverRequests.push(calls.map((call) => call.toolCall.id))
            return new Map([
              [
                "missing",
                {
                  content: "recovered from store",
                  preview: "recovered",
                  message_extras: { replayed: true }
                }
              ]
            ])
          }
        }
      }
    )
    const messages: ChatMessage[] = [
      { role: "user", content: "resume" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "done", type: "function", function: { name: "first", arguments: "{}" } },
          { id: "missing", type: "function", function: { name: "finish", arguments: "{}" } }
        ]
      },
      { role: "tool", tool_call_id: "done", content: "already done" }
    ]
    const result = await agent.run(messages)

    expect(result.stop_reason).toBe("end_turn")
    expect(result.steps).toBe(1)
    expect(result.text).toBe("recovered from store")
    expect(model.requests).toHaveLength(0)
    expect(tools.calls).toHaveLength(0)
    expect(recoverRequests).toEqual([["missing"]])
    expect(result.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "missing",
        content: "recovered from store",
        replayed: true
      })
    )
    expect(result.messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        client_id: "tool-media:missing",
        is_meta: true,
        content: expect.arrayContaining([recoveredContext])
      })
    )
  })

  it("executes only unrecovered calls, resolving hidden metadata and seeding deferred names", async () => {
    const model = scriptedProvider([[response({ content: "recovered and continued" })]])
    let activeHidden = 0
    let maxActiveHidden = 0
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    const tools = toolset([tool("deferred", { deferred: true })], async (request) => {
      if (request.name !== "hidden_mutation") return { content: "recovered", preview: "recovered" }
      activeHidden += 1
      maxActiveHidden = Math.max(maxActiveHidden, activeHidden)
      await tick()
      await tick()
      activeHidden -= 1
      return { content: "mutated", preview: "mutated" }
    })
    const seeded: Array<ReadonlySet<string>> = []
    const metadataRequests: string[] = []
    const loadedRequests: Array<ReadonlySet<string>> = []
    const seededShape: Toolset = {
      ...tools.shape,
      load: (names) => {
        loadedRequests.push(new Set(names))
      },
      metadata: (name) => {
        metadataRequests.push(name)
        return name === "hidden_mutation"
          ? { name, changes_state: true, concurrency_group: "session" }
          : undefined
      },
      seedLoadedNames: (names) => {
        seeded.push(new Set(names))
        for (const name of names) tools.loaded.add(name)
      }
    }
    const agent = makeAgent(
      { model: "test-model" },
      { provider: model.shape, toolset: seededShape }
    )
    const messages: ChatMessage[] = [
      { role: "user", content: "resume" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "pending", type: "function", function: { name: "deferred", arguments: "{}" } },
          {
            id: "hidden-1",
            type: "function",
            function: { name: "hidden_mutation", arguments: "{}" }
          },
          {
            id: "hidden-2",
            type: "function",
            function: { name: "hidden_mutation", arguments: "{}" }
          }
        ]
      }
    ]
    const output = await agent.run(messages)

    expect(output.text).toBe("recovered and continued")
    expect(seeded).toEqual([new Set(["deferred"])])
    expect(metadataRequests).toEqual(["hidden_mutation"])
    expect(tools.calls.map((call) => call.name)).toEqual([
      "deferred",
      "hidden_mutation",
      "hidden_mutation"
    ])
    expect(maxActiveHidden).toBe(1)
    expect(loadedRequests).toEqual([])
    expect(
      model.requests[0]?.tools.some((schema) => JSON.stringify(schema).includes("deferred"))
    ).toBe(true)
    expect(
      model.requests[0]?.tools.some((schema) => JSON.stringify(schema).includes("hidden_mutation"))
    ).toBe(false)
  })
  it.each([
    { bg: "its output", bgOutput: true, calls: ["gated"] },
    { bg: "no output", bgOutput: false, calls: ["bg", "gated"] }
  ])(
    "resumes an approved call whose step also launched a native background call ($bg)",
    async ({ bgOutput, calls }) => {
      const model = scriptedProvider([[response({ content: "created" })]])
      const tools = toolset([tool("search"), tool("create")], () => ({
        content: "done",
        preview: "done"
      }))
      const agent = makeAgent(
        { model: "test-model" },
        { provider: model.shape, toolset: tools.shape }
      )
      const messages: ChatMessage[] = [
        { role: "user", content: "remind me before calls" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "bg", type: "function", function: { name: "search", arguments: "{}" } },
            { id: "gated", type: "function", function: { name: "create", arguments: "{}" } }
          ]
        },
        {
          role: "user",
          is_meta: true,
          content: [],
          async_tool_launch: { call_id: "bg", delivery: "native" }
        },
        ...(bgOutput ? [{ role: "tool" as const, tool_call_id: "bg", content: "1 event" }] : [])
      ]
      const result = await agent.run(messages)

      expect(tools.calls.map((call) => call.toolCallId)).toEqual(calls)
      expect(result.messages).toContainEqual(
        expect.objectContaining({ role: "tool", tool_call_id: "gated", content: "done" })
      )
      expect(result.text).toBe("created")
    }
  )
})
