import { expect, it } from "vitest"
import type { ChatMessage, InteractionMessage } from "../src/index.js"
import { projectInteractions } from "../src/agent/interactions.js"

const workflow: InteractionMessage = {
  role: "interaction",
  message_id: "w",
  from: { source: "workflow", id: "wf-1" },
  to: { source: "agent", id: "researcher" },
  kind: "completion",
  outcome: "completed",
  content: "[1, 2]"
}
const peer: InteractionMessage = {
  role: "interaction",
  message_id: "p",
  from: { source: "agent", id: "lead" },
  to: { source: "agent", id: "researcher" },
  kind: "message",
  content: "Check the archive too."
}
const notice: InteractionMessage = {
  role: "interaction",
  message_id: "n",
  from: { source: "harness", id: "output_limit" },
  kind: "instruction",
  content: "Continue."
}

it("sends harness notices as the user's turn with their own content", () => {
  expect(projectInteractions([notice], false)).toEqual([
    { role: "user", message_id: "n", content: "Continue." }
  ])
})

it("renders agent and workflow mail as text, or keeps agent mail native", () => {
  const projected: ReadonlyArray<ChatMessage> = projectInteractions([workflow, peer], true)
  expect(projected[0]).toMatchObject({ role: "assistant", message_id: "w" })
  expect(projected[0]?.content).toContain("From: workflow:wf-1")
  expect(projected[0]?.content).toContain("Outcome: completed\n[1, 2]")
  expect(projected[1]).toBe(peer)
})
