import { expect, it } from "vitest"
import {
  createTool,
  makeAgent,
  type AgentStreamEvent,
  type ChatMessage,
  type CompletionResponse,
  type ToolCall,
  type Toolset
} from "../src/index.js"
import { deferred } from "./kit.js"

const response = (calls: ReadonlyArray<ToolCall> = [], content = "Done"): CompletionResponse => ({
  model: "test",
  usage: { completion_tokens: 1 },
  _tag: "Completed",
  message: { role: "assistant", content, tool_calls: calls, reasoning_content: null },
  finish_reason: calls.length > 0 ? "tool_calls" : "stop"
})
const call: ToolCall = {
  id: "lookup-1",
  type: "function",
  function: { name: "lookup", arguments: "{}" }
}
const toolset = (execute: Toolset["execute"]): Toolset => ({
  entries: () => [
    {
      description: "",
      parameters: {},
      meta: { name: "lookup", background: true }
    }
  ],
  loadedNames: () => new Set(),
  load: () => undefined,
  execute
})

it.each(["native", "message"] as const)(
  "continues independent work while a %s tool runs, then delivers exactly once",
  async (mode) => {
    const ready = deferred()
    let executions = 0
    let step = 0
    const checkpoints: Array<ReadonlyArray<ChatMessage>> = []
    const checkpointChanges: string[] = []
    const requests: ReadonlyArray<ChatMessage>[] = []
    const agent = makeAgent(
      { model: "test", maxIterations: 8, backgroundGraceMs: 0 },
      {
        provider: {
          protocolVersion: 1,
          capabilities: () => ({ hostedTools: [], structuredOutput: "none", asyncTools: mode }),
          stream: (request) => {
            requests.push(structuredClone(request.messages))
            step += 1
            if (step === 1)
              return [response([{ ...call, ...(mode === "native" ? { async: true } : {}) }], "")]
            if (step === 2) {
              expect(executions).toBe(1)
              expect(JSON.stringify(request.messages)).not.toContain("lookup result")
              ready.resolve()
              return [response([], "Independent work")]
            }
            return [response()]
          }
        },
        toolset: toolset(async () => {
          executions += 1
          expect(checkpoints.length).toBeGreaterThan(0)
          await ready.promise
          return { content: "lookup result", preview: "Found" }
        }),
        hooks: {
          onCheckpoint: (messages, change) => {
            checkpoints.push(structuredClone([...messages]))
            checkpointChanges.push(change.kind)
          }
        }
      }
    )
    const result = await agent.run([
      { role: "user", content: "Look it up and do independent work" }
    ])
    expect(result.text).toBe("Done")
    expect(executions).toBe(1)
    expect(checkpointChanges).toContain("append")
    expect(requests).toHaveLength(3)
    const outputs = result.messages.filter((message) => message.role === "tool")
    expect(outputs).toHaveLength(1)
    if (mode === "native") expect(outputs[0]?.content).toBe("lookup result")
    else
      expect(
        result.messages.filter((message) => message.client_id === "async-result:lookup-1")
      ).toHaveLength(1)
  }
)

it("a message queued while the run waits on a background call steers it without cancelling the call", async () => {
  const finish = deferred()
  const queued: ChatMessage[] = []
  let wake: (() => void) | undefined
  let cancelled = false
  let step = 0
  const agent = makeAgent(
    { model: "test", maxIterations: 8, backgroundGraceMs: 0 },
    {
      provider: {
        protocolVersion: 1,
        capabilities: () => ({ hostedTools: [], structuredOutput: "none", asyncTools: "message" }),
        stream: (request) => {
          step += 1
          if (step === 1) return [response([call], "")]
          if (step === 2) {
            setTimeout(() => {
              queued.push({ role: "user", message_id: "question", content: "why u stopped?" })
              wake?.()
            }, 0)
            return [response([], "Waiting on the lookup")]
          }
          if (step === 3) {
            expect(JSON.stringify(request.messages)).toContain("why u stopped?")
            expect(JSON.stringify(request.messages)).not.toContain("lookup result")
            finish.resolve()
            return [response([], "Still running; I did not stop it")]
          }
          return [response()]
        }
      },
      toolset: toolset(async (request) => {
        request.signal?.addEventListener("abort", () => {
          cancelled = true
        })
        await finish.promise
        return { content: "lookup result", preview: "Found" }
      }),
      hooks: {
        getPendingMessages: () => queued.splice(0),
        waitForPendingMessages: (signal) =>
          new Promise<void>((resolve) => {
            wake = resolve
            signal.addEventListener("abort", () => {
              wake = undefined
            })
          })
      }
    }
  )
  const result = await agent.run([{ role: "user", content: "Run the long lookup" }])
  expect(cancelled).toBe(false)
  expect(result.text).toBe("Done")
  expect(step).toBe(4)
  expect(
    result.messages.filter((message) => message.client_id === "async-result:lookup-1")
  ).toHaveLength(1)
})

it.each(["native", "message"] as const)(
  "a %s call that settles within the grace window joins the next request; a slower one does not hold it",
  async (mode) => {
    const requests: string[] = []
    const run = (settleMs: number) =>
      makeAgent(
        { model: "test", maxIterations: 8, backgroundGraceMs: 100 },
        {
          provider: {
            protocolVersion: 1,
            capabilities: () => ({ hostedTools: [], structuredOutput: "none", asyncTools: mode }),
            stream: (request) => {
              requests.push(JSON.stringify(request.messages))
              return requests.length === 1
                ? [response([{ ...call, ...(mode === "native" ? { async: true } : {}) }], "")]
                : [response()]
            }
          },
          toolset: toolset(async () => {
            await new Promise((resolve) => setTimeout(resolve, settleMs))
            return { content: "lookup result", preview: "Found" }
          })
        }
      ).run([{ role: "user", content: "Look it up" }])

    await run(5)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toContain("lookup result")

    requests.length = 0
    await run(300)
    expect(requests[1]).not.toContain("lookup result")
    expect(requests.at(-1)).toContain("lookup result")
  }
)

it("never runs a detached tool in the background", async () => {
  const parameters = {
    "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) }
  } as const
  expect(() =>
    createTool({
      name: "spawn",
      description: "",
      parameters,
      metadata: { background: true, detached: true },
      execute: async () => "started"
    })
  ).toThrow(/detached tools cannot run in the background/)

  const requests: string[] = []
  const detached: Toolset = {
    ...toolset(async () => ({ content: "job handle", preview: "Started" })),
    entries: () => [
      {
        description: "",
        parameters: {},
        meta: { name: "lookup", background: true, detached: true }
      }
    ]
  }
  await makeAgent(
    { model: "test", maxIterations: 4, backgroundGraceMs: 0 },
    {
      provider: {
        protocolVersion: 1,
        capabilities: () => ({ hostedTools: [], structuredOutput: "none", asyncTools: "message" }),
        stream: (request) => {
          requests.push(JSON.stringify(request.messages))
          return requests.length === 1 ? [response([call], "")] : [response()]
        }
      },
      toolset: detached
    }
  ).run([{ role: "user", content: "Start it" }])
  expect(requests[1]).toContain("job handle")
  expect(requests[1]).not.toContain("async_tool_launch")
  expect(requests.join("")).not.toContain('"status":"running"')
})

it("recovers an undelivered durable outcome without repeating execution", async () => {
  let executions = 0
  const history: ChatMessage[] = [
    { role: "assistant", content: "", tool_calls: [call] },
    {
      role: "tool",
      tool_call_id: call.id,
      message_id: `async-launch:${call.id}`,
      async_tool_launch: { call_id: call.id, delivery: "message" },
      content: "running"
    },
    { role: "assistant", content: "Independent work" }
  ]
  const result = await makeAgent(
    { model: "test" },
    {
      provider: { protocolVersion: 1, stream: () => [response()] },
      toolset: toolset(() => {
        executions += 1
        throw new Error("must recover")
      }),
      hooks: {
        recoverToolCalls: (calls) => {
          expect(calls.map((item) => item.toolCall.id)).toEqual([call.id])
          return new Map([[call.id, { content: "recovered", preview: "Found" }]])
        }
      }
    }
  ).run(history)
  expect(executions).toBe(0)
  expect(
    result.messages.filter((message) => message.client_id === "async-result:lookup-1")
  ).toHaveLength(1)
})

it("does not execute a background call if the launch checkpoint fails", async () => {
  let executions = 0
  await expect(
    makeAgent(
      { model: "test" },
      {
        provider: { protocolVersion: 1, stream: () => [response([call])] },
        toolset: toolset(() => {
          executions += 1
          return { content: "bad", preview: "bad" }
        }),
        hooks: {
          onCheckpoint: () => {
            throw new Error("disk unavailable")
          }
        }
      }
    ).run([{ role: "user", content: "Go" }])
  ).rejects.toThrow("disk unavailable")
  expect(executions).toBe(0)
})

it("bounds a pending tool wait by the invocation wall-time limit and aborts its signal", async () => {
  let signal: AbortSignal | undefined
  let step = 0
  const result = await makeAgent(
    { model: "test", maxWallTimeMs: 30 },
    {
      provider: {
        protocolVersion: 1,
        stream: () => [++step === 1 ? response([call], "") : response([], "Independent")]
      },
      toolset: toolset((request) => {
        signal = request.signal
        return new Promise(() => undefined)
      })
    }
  ).run([{ role: "user", content: "Go" }])
  expect(result.stop_reason).toBe("max_wall_time")
  expect(signal?.aborted).toBe(true)
})

it.each(["native", "message"] as const)(
  "settles post-answer background continuations on %s",
  async (mode) => {
    for (const scenario of ["quiet", "commentary", "new input", "useful follow-up"] as const) {
      const ready = deferred<void>()
      let step = 0
      let delivered = false
      const requests: ReadonlyArray<ChatMessage>[] = []
      const agent = makeAgent(
        {
          model: "test",
          backgroundGraceMs: 0
        },
        {
          provider: {
            protocolVersion: 1,
            capabilities: () => ({ hostedTools: [], structuredOutput: "none", asyncTools: mode }),
            stream: (request) => {
              requests.push(structuredClone(request.messages))
              step += 1
              if (step === 1)
                return [response([{ ...call, ...(mode === "native" ? { async: true } : {}) }], "")]
              if (step === 2) {
                ready.resolve()
                const answer = response([], "Findings")
                return [
                  {
                    ...answer,
                    message: {
                      ...answer.message,
                      output_parts: [
                        {
                          type: "text",
                          text: "Findings",
                          phase: scenario === "commentary" ? "commentary" : "final_answer"
                        }
                      ]
                    }
                  }
                ]
              }
              if (scenario === "useful follow-up") return [response([], "Saved artifact link")]
              return [response([], step === 3 ? "" : "New answer")]
            }
          },
          toolset: toolset(async () => {
            await ready.promise
            return { content: "Saved artifact", preview: "Saved" }
          }),
          hooks: {
            getPendingMessages: () => {
              if (scenario !== "new input" || step < 2 || delivered) return []
              delivered = true
              return [{ role: "user", content: "Another question" }]
            }
          }
        }
      )
      const result = await agent.run([{ role: "user", content: "Explain findings" }])
      expect({ text: result.text, stop: result.stop_reason, turns: step }).toEqual({
        text: {
          quiet: "",
          commentary: "",
          "new input": "",
          "useful follow-up": "Saved artifact link"
        }[scenario],
        stop: "end_turn",
        turns: 3
      })
      expect(JSON.stringify(requests[2])).toContain("Saved artifact")
      if (scenario === "new input")
        expect(requests[2]).toContainEqual({ role: "user", content: "Another question" })
    }
  }
)

it.each(["native", "message"] as const)(
  "bounds undelivered %s work, rejects excess calls, and admits a retry after delivery",
  async (mode) => {
    const calls = ["first", "excess-a", "excess-b", "retry"].map((id) => ({
      ...call,
      id,
      ...(mode === "native" ? { async: true } : {})
    }))
    const executed: string[] = []
    const events: AgentStreamEvent[] = []
    let step = 0
    let retried = false
    const agent = makeAgent(
      { model: "test", maxToolConcurrency: 1, backgroundGraceMs: 0, maxIterations: 8 },
      {
        provider: {
          protocolVersion: 1,
          capabilities: () => ({ hostedTools: [], structuredOutput: "none", asyncTools: mode }),
          stream: ({ messages }) => {
            step += 1
            if (step === 1) return [response(calls.slice(0, 3), "")]
            const firstDelivered = messages.some((message) =>
              mode === "native"
                ? message.role === "tool" && message.tool_call_id === "first"
                : message.client_id === "async-result:first"
            )
            if (firstDelivered && !retried) {
              retried = true
              return [response(calls.slice(3), "")]
            }
            return [response()]
          }
        },
        toolset: toolset((request) => {
          executed.push(request.toolCallId)
          return { content: request.toolCallId, preview: "Finished" }
        })
      }
    )
    for await (const event of agent.stream([{ role: "user", content: "Go" }])) events.push(event)
    const completions = events.flatMap((event) =>
      "_tag" in event && event._tag === "ToolCompleted"
        ? [{ id: event.tool_id, error: event.is_error, retryable: event.retryable }]
        : []
    )
    expect(executed).toEqual(["first", "retry"])
    expect(completions.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "excess-a", error: true, retryable: true },
      { id: "excess-b", error: true, retryable: true },
      { id: "first", error: false, retryable: null },
      { id: "retry", error: false, retryable: null }
    ])
    const result = events.at(-1)
    if (result === undefined || "_tag" in result) throw new Error("Expected the final result")
    expect(
      result.messages.flatMap((message) =>
        (message.role === "user" || message.role === "tool") &&
        message.async_tool_launch !== undefined
          ? [message.async_tool_launch.call_id]
          : []
      )
    ).toEqual(["first", "retry"])
  }
)

it.each(["native", "message"] as const)(
  "drains a persisted %s backlog larger than admission capacity without losing outcomes",
  async (mode) => {
    const calls = ["saved-a", "saved-b", "saved-c"].map((id) => ({
      ...call,
      id,
      async: mode === "native"
    }))
    const history: ChatMessage[] = [
      { role: "assistant", content: "", tool_calls: calls },
      ...calls.map((item): ChatMessage =>
        mode === "native"
          ? {
              role: "user",
              content: [],
              is_meta: true,
              message_id: `async-launch:${item.id}`,
              async_tool_launch: { call_id: item.id, delivery: mode }
            }
          : {
              role: "tool",
              content: "running",
              tool_call_id: item.id,
              message_id: `async-launch:${item.id}`,
              async_tool_launch: { call_id: item.id, delivery: mode }
            }
      )
    ]
    const result = await makeAgent(
      { model: "test", maxToolConcurrency: 1, backgroundGraceMs: 0, maxIterations: 8 },
      {
        provider: { protocolVersion: 1, stream: () => [response()] },
        toolset: toolset(() => {
          throw new Error("Recovered outcomes must not execute")
        }),
        hooks: {
          recoverToolCalls: () =>
            new Map(calls.map((item) => [item.id, { content: item.id, preview: "Recovered" }]))
        }
      }
    ).run(history)
    const delivered = result.messages.flatMap((message) => {
      if (mode === "native") return message.role === "tool" ? [message.tool_call_id] : []
      return message.client_id?.startsWith("async-result:") === true
        ? [message.client_id.slice("async-result:".length)]
        : []
    })
    expect(delivered).toEqual(["saved-a", "saved-b", "saved-c"])
    expect(result.stop_reason).toBe("end_turn")
  }
)

it("waits for a pending result instead of spinning on empty provider continuations", async () => {
  const ready = deferred<void>()
  let steps = 0
  const result = await makeAgent(
    { model: "test", maxIterations: 6, backgroundGraceMs: 0 },
    {
      provider: {
        protocolVersion: 1,
        stream: (request) => {
          steps += 1
          if (steps === 1) return [response([call], "")]
          if (JSON.stringify(request.messages).includes("lookup result")) return [response()]
          return [{ ...response([], ""), continuation: true }]
        }
      },
      toolset: toolset(async () => {
        await ready.promise
        return { content: "lookup result", preview: "Found" }
      }),
      hooks: {
        waitForPendingMessages: (signal) => {
          ready.resolve()
          return new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          )
        }
      }
    }
  ).run([{ role: "user", content: "Look it up" }])
  expect({ steps, text: result.text, stop: result.stop_reason }).toEqual({
    steps: 3,
    text: "Done",
    stop: "end_turn"
  })
})
