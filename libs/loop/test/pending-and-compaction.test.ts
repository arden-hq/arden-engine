import { describe, expect, it } from "vitest"

import { makeAgent, type ChatMessage, type ModelStreamItem } from "../src/index.js"
import { scriptedProvider } from "./kit.js"

const response = (options: { content?: string | null; completionTokens?: number } = {}) => ({
  model: "test-model",
  _tag: "Completed" as const,
  message: {
    role: "assistant" as const,
    content: options.content ?? null,
    tool_calls: [],
    reasoning_content: null
  },
  finish_reason: "stop" as const,
  usage: { prompt_tokens: 9, completion_tokens: options.completionTokens ?? 1 }
})

const provider = (
  turns: ReadonlyArray<ReadonlyArray<ModelStreamItem>>,
  agentMessages?: "native" | "message"
) =>
  scriptedProvider(
    turns,
    agentMessages === undefined
      ? undefined
      : () => ({ agentMessages, hostedTools: [], structuredOutput: "none" })
  )

describe("pending messages and compaction", () => {
  it("checkpoints a resumed tool output before draining pending input", async () => {
    const order: string[] = []
    const checkpoints: Array<ReadonlyArray<ChatMessage>> = []
    let pending = true
    const model = provider([[response({ content: "continued" })]])
    const agent = makeAgent(
      { model: "test-model" },
      {
        provider: model.shape,
        toolset: {
          entries: () => [
            {
              description: "Inspect one value",
              parameters: { type: "object", properties: {} },
              meta: { name: "inspect", changes_state: false }
            }
          ],
          loadedNames: () => new Set(),
          load: () => undefined,
          execute: () => ({ content: "inspected", preview: "Inspected" })
        },
        hooks: {
          onStepFinish: (_step, _response, messages) => {
            order.push("checkpoint")
            checkpoints.push(structuredClone(messages))
          },
          getPendingMessages: () => {
            order.push("drain")
            if (!pending) return []
            pending = false
            return [{ role: "user", content: "new input" }]
          }
        }
      }
    )

    const output = await agent.run([
      { role: "user", content: "begin" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-inspect",
            type: "function",
            function: { name: "inspect", arguments: "{}" }
          }
        ]
      }
    ])

    expect(order.slice(0, 2)).toEqual(["checkpoint", "drain"])
    expect(checkpoints[0]).toMatchObject([
      { role: "user", content: "begin" },
      { role: "assistant", tool_calls: [{ id: "call-inspect" }] },
      { role: "tool", tool_call_id: "call-inspect", content: "inspected" }
    ])
    expect(model.requests[0]?.messages).toMatchObject([
      { role: "system" },
      { role: "user", content: "begin" },
      { role: "assistant", tool_calls: [{ id: "call-inspect" }] },
      { role: "tool", tool_call_id: "call-inspect", content: "inspected" },
      { role: "user", content: "new input" }
    ])
    expect(output.text).toBe("continued")
  })
})
