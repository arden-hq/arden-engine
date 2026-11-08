import { describe, expect, it } from "vitest"

import {
  ToolExecutionError,
  makeAgent,
  makeRunBudget,
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
    toolCalls?: ReadonlyArray<{ id: string; name: string }>
    completionTokens?: number
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
  usage: { prompt_tokens: 1, completion_tokens: options.completionTokens ?? 1 }
})

const tool = (name: string): ToolEntry => ({
  description: name,
  parameters: { type: "object", properties: {} },
  meta: { name, host: { display_name: name } }
})

const toolset = (
  entries: ReadonlyArray<ToolEntry>,
  behavior: (request: ToolCallRequest) => ToolResult | Promise<ToolResult>
) => {
  const calls: ToolCallRequest[] = []
  const shape: Toolset = {
    entries: () => entries,
    loadedNames: () => new Set<string>(),
    load: () => undefined,
    execute: (request) => {
      calls.push(request)
      return behavior(request)
    }
  }
  return { shape, calls }
}

describe("budgets, limits, and forced finalization", () => {
  it("stops on token budget with ONE forced finalization call: no tools, toolChoice none", async () => {
    const budget = makeRunBudget({ totalOutputTokens: 50 })
    const model = scriptedProvider([
      [
        response({
          finishReason: "tool_calls",
          toolCalls: [{ id: "evidence-1", name: "evidence" }],
          completionTokens: 10
        })
      ],
      [response({ content: "final answer", completionTokens: 5 })]
    ])
    const tools = toolset([tool("evidence")], async () => {
      await budget.addOutputTokens(75)
      return { content: "child evidence", preview: "evidence" }
    })
    const agent = makeAgent(
      {
        model: "test-model",
        policy: { finalizeInstruction: "FINALIZE NOW" }
      },
      { provider: model.shape, toolset: tools.shape, budget }
    )
    const final = await agent.run([{ role: "user", content: "use evidence" }])
    expect(final.stop_reason).toBe("max_token_budget")
    expect(final.text).toBe("final answer")
    expect(model.requests).toHaveLength(2)
    expect(model.requests[1]?.tools).toEqual([])
    expect(model.requests[1]?.toolChoice).toBe("none")
    expect(JSON.stringify(model.requests[1]?.messages)).toContain("FINALIZE NOW")
  })

  it("stops after N all-error non-retryable steps with NO_PROGRESS", async () => {
    const model = scriptedProvider([
      [response({ finishReason: "tool_calls", toolCalls: [{ id: "n1", name: "broken" }] })],
      [response({ finishReason: "tool_calls", toolCalls: [{ id: "n2", name: "broken" }] })]
    ])
    const tools = toolset([tool("broken")], () => {
      throw new ToolExecutionError("permanent", { retryable: false })
    })
    const agent = makeAgent(
      { model: "test-model", maxNoProgressSteps: 2 },
      {
        provider: model.shape,
        toolset: tools.shape
      }
    )
    const result = await agent.run([{ role: "user", content: "go" }])
    expect(result.stop_reason).toBe("no_progress")
    expect(model.requests).toHaveLength(2)
  })
})
