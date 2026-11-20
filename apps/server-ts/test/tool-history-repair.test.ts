import type { ChatMessage } from "@arden-hq/loop"
import { expect, it } from "vitest"
import { repairOrphanToolOutputs } from "../src/chat/tool-history-repair.js"

const call = { id: "bg", type: "function" as const, function: { name: "lookup", arguments: "{}" } }

it("keeps a background call's late result after its receipt", () => {
  const messages: ReadonlyArray<ChatMessage> = [
    { role: "assistant", content: "", tool_calls: [call] },
    { role: "tool", tool_call_id: "bg", content: "running", async_tool_launch: { call_id: "bg" } },
    { role: "assistant", content: "Waiting" },
    { role: "tool", tool_call_id: "bg", content: "B out" }
  ]
  expect(repairOrphanToolOutputs(messages)).toEqual({ messages, orphans: [] })
})

it("still turns a result whose call is gone into context", () => {
  const repaired = repairOrphanToolOutputs([
    { role: "tool", tool_call_id: "gone", message_id: "m", content: "old" }
  ])
  expect(repaired.orphans).toEqual([{ callId: "gone", messageId: "m" }])
  expect(repaired.messages[0]?.role).toBe("interaction")
})
