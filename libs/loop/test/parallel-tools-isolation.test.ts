import { describe, expect, it } from "vitest"

import {
  ToolExecutionError,
  makeAgent,
  type AgentEvent,
  type AgentStreamEvent,
  type ToolCallRequest,
  type ToolEntry,
  type ToolMeta,
  type Toolset
} from "../src/index.js"
import { deferred, entryOf, lastOf } from "./kit.js"

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

const tool = (name: string, options: { endsTurn?: ToolMeta["ends_turn"] } = {}): ToolEntry => ({
  description: name,
  parameters: { type: "object", properties: {} },
  meta: { name, ends_turn: options.endsTurn ?? false, host: { display_name: name } }
})

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("parallel tools with per-tool isolation", () => {
  it("starts queued tools only after acquiring an execution permit", async () => {
    const first = deferred(),
      second = deferred(),
      release = deferred()
    const events: AgentStreamEvent[] = []
    const agent = makeAgent(
      { model: "test-model", maxToolConcurrency: 1 },
      {
        provider: {
          protocolVersion: 1,
          stream: ({ messages }) =>
            messages.some((message) => message.role === "tool")
              ? [response({ content: "done" })]
              : [
                  response({
                    finishReason: "tool_calls",
                    toolCalls: [
                      { id: "first", name: "lookup" },
                      { id: "second", name: "lookup" }
                    ]
                  })
                ]
        },
        toolset: {
          entries: () => [tool("lookup")],
          loadedNames: () => new Set(),
          load: () => {},
          execute: async (request) => {
            if (request.toolCallId === "first") {
              first.resolve()
              await release.promise
            } else second.resolve()
            return { content: "ok", preview: "ok" }
          }
        }
      }
    )
    const running = (async () => {
      for await (const event of agent.stream([{ role: "user", content: "go" }])) events.push(event)
    })()
    await first.promise
    await tick()
    const starts = () =>
      events.flatMap((event) =>
        "_tag" in event && event._tag === "ToolStarted" ? [event.tool_id] : []
      )
    try {
      expect(starts()).toEqual(["first"])
    } finally {
      release.resolve()
      await second.promise
      await running
    }
    expect(starts()).toEqual(["first", "second"])
  })

  it("lets an independent tool run while another call waits for its concurrency group", async () => {
    const first = deferred()
    const release = deferred()
    const executed: string[] = []
    const agent = makeAgent(
      { model: "test-model", maxToolConcurrency: 2 },
      {
        provider: {
          protocolVersion: 1,
          stream: ({ messages }) =>
            messages.some((message) => message.role === "tool")
              ? [response({ content: "done" })]
              : [
                  response({
                    finishReason: "tool_calls",
                    toolCalls: [
                      { id: "first", name: "write" },
                      { id: "queued", name: "write" },
                      { id: "independent", name: "lookup" }
                    ]
                  })
                ]
        },
        toolset: {
          entries: () => [
            { ...tool("write"), meta: { name: "write", changes_state: true } },
            tool("lookup")
          ],
          loadedNames: () => new Set(),
          load: () => {},
          execute: async (request) => {
            executed.push(request.toolCallId)
            if (request.toolCallId === "first") {
              first.resolve()
              await release.promise
            }
            return { content: "ok", preview: "ok" }
          }
        }
      }
    )
    const running = agent.run([{ role: "user", content: "go" }])
    await first.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      expect([...executed].sort()).toEqual(["first", "independent"])
    } finally {
      release.resolve()
      await running
    }
    expect(executed.at(-1)).toBe("queued")
  })

  it("runs state-changing calls of different tools one at a time, in the model's order", async () => {
    const first = deferred()
    const release = deferred()
    const executed: string[] = []
    const writer = (name: string): ToolEntry => ({
      ...tool(name),
      meta: { name, changes_state: true }
    })
    const agent = makeAgent(
      { model: "test-model", maxToolConcurrency: 4 },
      {
        provider: {
          protocolVersion: 1,
          stream: ({ messages }) =>
            messages.some((message) => message.role === "tool")
              ? [response({ content: "done" })]
              : [
                  response({
                    finishReason: "tool_calls",
                    toolCalls: [
                      { id: "first", name: "remote" },
                      { id: "second", name: "note" }
                    ]
                  })
                ]
        },
        toolset: {
          entries: () => [writer("remote"), writer("note")],
          loadedNames: () => new Set(),
          load: () => {},
          execute: async (request) => {
            executed.push(request.toolCallId)
            if (request.toolCallId === "first") {
              first.resolve()
              await release.promise
            }
            return { content: "ok", preview: "ok" }
          }
        }
      }
    )
    const running = agent.run([{ role: "user", content: "go" }])
    await first.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    const beforeRelease = [...executed]
    release.resolve()
    await running
    expect(beforeRelease).toEqual(["first"])
    expect(executed).toEqual(["first", "second"])
  })

  it("emits execution starts, settles in completion order, isolates failures", async () => {
    const gates = new Map([
      ["ok", deferred()],
      ["fails", deferred()],
      ["defects", deferred()]
    ])
    const trace: string[] = []
    const toolset: Toolset = {
      entries: () => [tool("ok"), tool("fails"), tool("defects")],
      loadedNames: () => new Set<string>(),
      load: () => undefined,
      execute: async (request: ToolCallRequest) => {
        trace.push(`execute:${request.name}`)
        await entryOf(gates, request.name).promise
        if (request.name === "fails") {
          throw new ToolExecutionError("safe failure", { preview: "failed", retryable: false })
        }
        if (request.name === "defects") throw new Error("raw defect")
        return { content: "fine", preview: "fine" }
      }
    }
    const agent = makeAgent(
      { model: "test-model" },
      {
        provider: {
          protocolVersion: 1 as const,
          stream: ({ messages }) =>
            messages.some((message) => message.role === "tool")
              ? [response({ content: "done" })]
              : [
                  response({
                    finishReason: "tool_calls",
                    toolCalls: [
                      { id: "c1", name: "ok" },
                      { id: "c2", name: "fails" },
                      { id: "c3", name: "defects" }
                    ]
                  })
                ]
        },
        toolset
      }
    )

    const events: AgentStreamEvent[] = []
    const consume = (async () => {
      for await (const event of agent.stream([{ role: "user", content: "go" }])) events.push(event)
    })()
    await tick()
    await tick()
    const tags = (list: ReadonlyArray<AgentStreamEvent>) =>
      list.map((event) =>
        "_tag" in event ? `${event._tag}:${"tool_id" in event ? event.tool_id : ""}` : "Result"
      )
    expect(tags(events)).toEqual([
      "InputTaken:",
      "TextStarted:",
      "TextEnded:",
      "ToolInputStarted:c1",
      "ToolInputDelta:c1",
      "ToolInputEnded:c1",
      "ToolInputStarted:c2",
      "ToolInputDelta:c2",
      "ToolInputEnded:c2",
      "ToolInputStarted:c3",
      "ToolInputDelta:c3",
      "ToolInputEnded:c3",
      "ToolStarted:c1",
      "ToolStarted:c2",
      "ToolStarted:c3"
    ])
    expect(new Set(trace)).toEqual(new Set(["execute:ok", "execute:fails", "execute:defects"]))

    entryOf(gates, "defects").resolve()
    await tick()
    entryOf(gates, "fails").resolve()
    await tick()
    entryOf(gates, "ok").resolve()
    await consume

    expect(
      events.flatMap((event) =>
        "_tag" in event && event._tag === "ToolStarted" ? [event.tool_id] : []
      )
    ).toEqual(["c1", "c2", "c3"])
    const completions = events.filter(
      (event): event is Extract<AgentEvent, { _tag: "ToolCompleted" }> =>
        "_tag" in event && event._tag === "ToolCompleted"
    )
    expect(completions.map((event) => event.tool_id)).toEqual(["c3", "c2", "c1"])
    const byId = new Map(completions.map((event) => [event.tool_id, event]))
    expect(byId.get("c2")).toMatchObject({
      result: "safe failure",
      is_error: true,
      retryable: false
    })
    expect(byId.get("c3")).toMatchObject({ result: "raw defect", is_error: true })
    expect(byId.get("c1")).toMatchObject({ result: "fine", is_error: false })
    const result = lastOf(events)
    expect("stop_reason" in result && result.stop_reason).toBe("end_turn")
    expect("text" in result && result.text).toBe("done")
  })

  it("refuses only a turn-ending call made beside other tools; the others run", async () => {
    const executed: string[] = []
    const toolset: Toolset = {
      entries: () => [tool("read"), tool("finish", { endsTurn: true })],
      loadedNames: () => new Set<string>(),
      load: () => undefined,
      execute: async (request: ToolCallRequest) => {
        executed.push(request.name)
        return { content: request.name === "finish" ? "finished" : "history", preview: "ok" }
      }
    }
    let step = 0
    const agent = makeAgent(
      { model: "test-model" },
      {
        provider: {
          protocolVersion: 1 as const,
          stream: () => {
            step += 1
            return step === 1
              ? [
                  response({
                    finishReason: "tool_calls",
                    toolCalls: [
                      { id: "r1", name: "read" },
                      { id: "f1", name: "finish" }
                    ]
                  })
                ]
              : [
                  response({
                    finishReason: "tool_calls",
                    toolCalls: [{ id: "f2", name: "finish" }]
                  })
                ]
          }
        },
        toolset
      }
    )
    const events: AgentStreamEvent[] = []
    for await (const event of agent.stream([{ role: "user", content: "go" }])) events.push(event)
    const completed = events.filter(
      (event): event is Extract<AgentEvent, { _tag: "ToolCompleted" }> =>
        "_tag" in event && event._tag === "ToolCompleted"
    )
    const byId = new Map(completed.map((event) => [event.tool_id, event]))
    expect(executed).toEqual(["read", "finish"])
    expect(byId.get("r1")).toMatchObject({ result: "history", is_error: false })
    expect(byId.get("f1")).toMatchObject({ is_error: true })
    const result = lastOf(events)
    expect("stop_reason" in result && result.stop_reason).toBe("end_turn")
    expect("text" in result && result.text).toBe("finished")
  })

  it("ends the turn only for the argument value a conditional ends_turn names", async () => {
    const executed: string[] = []
    const toolset: Toolset = {
      entries: () => [
        tool("read"),
        tool("report", { endsTurn: { argument: "event", equals: "blocked" } })
      ],
      loadedNames: () => new Set<string>(),
      load: () => undefined,
      execute: async (request: ToolCallRequest) => {
        executed.push(`${request.name}:${String(request.args["event"] ?? "")}`)
        return {
          content: request.name === "report" ? "Blocked: no access" : "history",
          preview: "ok"
        }
      }
    }
    const steps = [
      [
        { id: "r1", name: "read" },
        { id: "p1", name: "report", arguments: '{"event":"finished"}' }
      ],
      [
        { id: "r2", name: "read" },
        { id: "b1", name: "report", arguments: '{"event":"blocked"}' }
      ],
      [{ id: "b2", name: "report", arguments: '{"event":"blocked"}' }]
    ]
    let step = 0
    const agent = makeAgent(
      { model: "test-model" },
      {
        provider: {
          protocolVersion: 1 as const,
          stream: () => {
            step += 1
            return [response({ finishReason: "tool_calls", toolCalls: steps[step - 1] ?? [] })]
          }
        },
        toolset
      }
    )
    const events: AgentStreamEvent[] = []
    for await (const event of agent.stream([{ role: "user", content: "go" }])) events.push(event)
    const completed = events.filter(
      (event): event is Extract<AgentEvent, { _tag: "ToolCompleted" }> =>
        "_tag" in event && event._tag === "ToolCompleted"
    )
    const byId = new Map(completed.map((event) => [event.tool_id, event]))
    expect(executed).toEqual(["read:", "report:finished", "read:", "report:blocked"])
    expect(byId.get("p1")).toMatchObject({ is_error: false, ends_turn: false })
    expect(byId.get("b1")).toMatchObject({ is_error: true })
    expect(byId.get("b2")).toMatchObject({ is_error: false, ends_turn: true })
    const result = lastOf(events)
    expect("stop_reason" in result && result.stop_reason).toBe("end_turn")
    expect("text" in result && result.text).toBe("Blocked: no access")
  })
})
