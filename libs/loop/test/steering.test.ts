import { expect, it } from "vitest"
import {
  makeAgent,
  type Metadata,
  type ModelCapabilities,
  type Toolset,
  type ChatMessage
} from "../src/index.js"
import {
  makeOpenAiResponsesProvider,
  type ResponsesWebSocket
} from "../src/providers/openai-responses/provider.js"
import { RetryableProviderError } from "../src/providers/kit/index.js"
import { EventQueue } from "../src/internal/stream.js"

const nativeRoute = (): ModelCapabilities => ({
  hostedTools: ["web_search"],
  structuredOutput: "native",
  asyncTools: "native",
  steering: "native"
})

const emptyTools: Toolset = {
  entries: () => [],
  loadedNames: () => new Set(),
  load: () => undefined,
  execute: () => {
    throw new Error("unexpected tool")
  }
}
const terminal = (id: string, output: ReadonlyArray<Metadata>, type = "response.completed") => ({
  type,
  response: {
    id,
    status: type === "response.completed" ? "completed" : "incomplete",
    output,
    usage: { input_tokens: 2, output_tokens: 1 },
    ...(type === "response.incomplete" ? { incomplete_details: { reason: "steered" } } : {})
  }
})
const text = (id: string, value: string) => ({
  type: "message",
  id,
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: value }]
})

it.each(["automatic", "tool", "failed"] as const)(
  "handles %s steering without replaying accepted input",
  async (mode) => {
    const queue = new EventQueue<unknown>()
    const sent: Metadata[] = []
    let closed = false
    let pendingChecks = 0
    const checkpoints: ChatMessage[][] = []
    const socket: ResponsesWebSocket = {
      isClosed: () => false,
      events: { [Symbol.asyncIterator]: () => queue },
      close: () => {
        closed = true
        queue.end()
      },
      send: (event) => {
        sent.push(event)
        if (sent.length === 1) {
          void queue.push({ type: "response.created", response: { id: "r1" } })
          return
        }
        if (event.type === "response.steer") {
          if (mode === "failed") {
            void queue.push({
              type: "response.steer.failed",
              steer: { previous_response_id: "r1" },
              error: { code: "steering_not_supported" }
            })
            void queue.push(terminal("r1", [text("m1", "Original")]))
            return
          }
          void queue.push({
            type: "response.steer.accepted",
            steer: { id: "s1", previous_response_id: "r1" }
          })
          if (mode === "tool") {
            void queue.push(
              terminal("r1", [
                {
                  type: "function_call",
                  id: "fc1",
                  call_id: "c1",
                  name: "lookup",
                  arguments: "{}",
                  status: "completed"
                }
              ])
            )
            void queue.push({
              type: "response.steer.pending",
              steer: { id: "s1", previous_response_id: "r1" },
              required_input: [{ type: "function_call_output", call_id: "c1" }]
            })
            return
          }
          void queue.push(terminal("r1", [text("m1", "Original")], "response.incomplete"))
        }
        void queue.push({ type: "response.created", response: { id: "r2" } })
        void queue.push(terminal("r2", [text("m2", "Updated")]))
      }
    }
    const provider = makeOpenAiResponsesProvider({
      auth: { headers: async () => ({}) },
      capabilities: nativeRoute,
      transport: () => "websocket",
      connectWebSocket: async () => socket
    })
    const result = await makeAgent(
      { model: "gpt-6-astra", maxIterations: 6 },
      {
        provider,
        toolset:
          mode === "tool"
            ? {
                ...emptyTools,
                entries: () => [
                  {
                    description: "",
                    parameters: {},
                    meta: { name: "lookup" }
                  }
                ],
                execute: () => ({ content: "Found", preview: "Found" })
              }
            : emptyTools,
        hooks: {
          getPendingMessages: () =>
            ++pendingChecks === 2 ? [{ role: "user", content: "Keep it small" }] : [],
          onCheckpoint: (messages) => {
            checkpoints.push(structuredClone([...messages]))
          }
        }
      }
    ).run([{ role: "user", content: "Make a plan" }])
    expect(result.text).toBe("Updated")
    expect(result.messages.filter((message) => message.content === "Keep it small")).toHaveLength(1)
    expect(closed).toBe(true)
    expect(sent.filter((event) => event.type === "response.steer")).toEqual([
      {
        type: "response.steer",
        previous_response_id: "r1",
        input: [{ role: "user", content: "Keep it small" }]
      }
    ])
    expect(sent.filter((event) => event.type === "response.create")).toHaveLength(
      mode === "automatic" ? 1 : 2
    )
    if (mode === "tool")
      expect(sent[2]?.input).toEqual([
        { type: "function_call_output", call_id: "c1", output: "Found", status: "completed" }
      ])
    expect(
      checkpoints.some((messages) =>
        messages.some((message) => message.content === "Keep it small")
      )
    ).toBe(true)
  }
)

it("retains input after an accepted steer disconnects, without replaying the response", async () => {
  const queue = new EventQueue<unknown>()
  const sent: Metadata[] = []
  let checks = 0
  let checkpoint: ReadonlyArray<ChatMessage> = []
  const provider = makeOpenAiResponsesProvider({
    auth: { headers: async () => ({}) },
    capabilities: nativeRoute,
    transport: () => "websocket",
    connectWebSocket: async () => ({
      isClosed: () => false,
      events: { [Symbol.asyncIterator]: () => queue },
      close: () => queue.end(),
      send: (event) => {
        sent.push(event)
        if (event.type === "response.create")
          void queue.push({ type: "response.created", response: { id: "r1" } })
        else {
          void queue.push({
            type: "response.steer.accepted",
            steer: { id: "s1", previous_response_id: "r1" }
          })
          queue.end()
        }
      }
    })
  })
  await expect(
    makeAgent(
      { model: "gpt-6-astra" },
      {
        provider,
        toolset: emptyTools,
        hooks: {
          getPendingMessages: () =>
            ++checks === 2 ? [{ role: "user", content: "Correction" }] : [],
          onCheckpoint: (messages) => {
            checkpoint = structuredClone(messages)
          }
        }
      }
    ).run([{ role: "user", content: "Plan" }])
  ).rejects.toThrow("disconnected")
  expect(sent.map((event) => event.type)).toEqual(["response.create", "response.steer"])
  expect(checkpoint.map((message) => message.content)).toEqual(["Plan", "Correction"])
})

it("falls back to SSE after its configured handshake attempt budget", async () => {
  let posts = 0
  const provider = makeOpenAiResponsesProvider({
    auth: { headers: async () => ({}) },
    capabilities: nativeRoute,
    transport: () => "websocket",
    maxAttempts: 1,
    connectWebSocket: async () => {
      throw new RetryableProviderError("WebSocket unavailable")
    },
    fetch: async () => {
      posts += 1
      return new Response(`data: ${JSON.stringify(terminal("r1", [text("m1", "Fallback")]))}\n\n`)
    }
  })
  const result = await makeAgent({ model: "gpt-6-astra" }, { provider, toolset: emptyTools }).run([
    { role: "user", content: "Go" }
  ])
  expect(result.text).toBe("Fallback")
  expect(posts).toBe(1)
})
