import { describe, expect, it } from "vitest"
import type { ChatMessage, ToolCall } from "../src/index.js"
import { projectToolHistory } from "../src/agent/history-projection.js"

const call = (id: string, async?: true): ToolCall => ({
  id,
  type: "function",
  function: { name: "lookup", arguments: "{}" },
  ...(async === undefined ? {} : { async })
})
const IMAGE = { type: "image", media_type: "image/png", data: "iVBORw0KGgo" } as const

const stored: ReadonlyArray<ChatMessage> = [
  { role: "user", content: "Go" },
  { role: "assistant", content: "", tool_calls: [call("sync"), call("bg", true)] },
  { role: "tool", tool_call_id: "sync", content: "S out", model_content: [IMAGE] },
  { role: "tool", tool_call_id: "bg", content: "running", async_tool_launch: { call_id: "bg" } },
  { role: "assistant", content: "Waiting" },
  { role: "tool", tool_call_id: "bg", content: "B out" }
]

const media = (id: string) => ({
  role: "user",
  is_meta: true,
  content: [
    {
      type: "context",
      content_type: "tool_result_media",
      content: "Media returned by tool lookup.",
      metadata: { tool_call_id: id, tool_name: "lookup" }
    },
    IMAGE
  ]
})

describe("projectToolHistory", () => {
  it("gives a message route the receipt as output and the late result as context", () => {
    expect(projectToolHistory({ messages: stored, nativeAsync: false })).toEqual([
      { role: "user", content: "Go" },
      { role: "assistant", content: "", tool_calls: [call("sync"), call("bg")] },
      { role: "tool", tool_call_id: "sync", content: "S out" },
      media("sync"),
      {
        role: "tool",
        tool_call_id: "bg",
        content: "running",
        async_tool_launch: { call_id: "bg" }
      },
      { role: "assistant", content: "Waiting" },
      {
        role: "user",
        is_meta: true,
        content: [
          {
            type: "context",
            content_type: "async_tool_result",
            content: "B out",
            metadata: { tool_call_id: "bg", tool_name: "lookup" }
          }
        ]
      }
    ])
  })

  it("gives a native route the late result as the call's output and no receipt", () => {
    expect(projectToolHistory({ messages: stored, nativeAsync: true })).toEqual([
      { role: "user", content: "Go" },
      { role: "assistant", content: "", tool_calls: [call("sync"), call("bg", true)] },
      { role: "tool", tool_call_id: "sync", content: "S out" },
      media("sync"),
      { role: "assistant", content: "Waiting" },
      { role: "tool", tool_call_id: "bg", content: "B out" }
    ])
  })
})
