import { expect, it } from "vitest"
import type { InteractionMessage } from "../src/index.js"
import { renderInteraction } from "../src/agent/interactions.js"
import { makePayload as chatCompletionsPayload } from "../src/providers/chat-completions/request.js"
import { DEFAULT_COMPAT } from "../src/providers/chat-completions/compat.js"
import { makePayload as responsesPayload } from "../src/providers/openai-responses/request.js"

const workflow: InteractionMessage = {
  role: "interaction",
  from: { source: "workflow", id: "wf-1" },
  to: { source: "agent", id: "researcher" },
  kind: "completion",
  outcome: "completed",
  content: "[1, 2]"
}
const peer: InteractionMessage = {
  role: "interaction",
  from: { source: "agent", id: "lead" },
  to: { source: "agent", id: "researcher" },
  kind: "message",
  content: "Check the archive too."
}
const notice: InteractionMessage = {
  role: "interaction",
  from: { source: "harness", id: "output_limit" },
  kind: "instruction",
  content: "Continue."
}
const request = (messages: ReadonlyArray<InteractionMessage>) => ({
  model: "m",
  messages: [{ role: "user" as const, content: "Go" }, ...messages],
  tools: [],
  deferredTools: [],
  toolChoice: "auto" as const,
  renderInteraction
})

it("a chat-completions request ends on the user's turn when a workflow result came last", () => {
  const { messages } = chatCompletionsPayload(request([notice, workflow]), {
    providerId: "p",
    label: "p",
    compat: DEFAULT_COMPAT,
    extraBody: {}
  })
  expect(messages.map((message) => message.role)).toEqual(["user", "user", "user"])
  expect(messages[1]).toEqual({ role: "user", content: "Continue." })
  expect(messages.at(-1)?.content).toContain("From: workflow:wf-1")
})

it("Responses sends mail between agents natively only where the route carries it", () => {
  const native = responsesPayload(request([peer, workflow]), "", undefined, {
    agentMessages: "native",
    asyncTools: "message"
  }).input
  expect(native[1]).toMatchObject({
    type: "agent_message",
    author: "lead",
    recipient: "researcher"
  })
  expect(native[2]).toMatchObject({ role: "user" })
  const plain = responsesPayload(request([peer]), "", undefined, {
    agentMessages: "message",
    asyncTools: "message"
  }).input
  expect(plain[1]).toMatchObject({ role: "user" })
})
