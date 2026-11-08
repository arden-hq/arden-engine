import { expect, it } from "vitest"
import {
  PauseRequested,
  createTool,
  createToolset,
  makeAgent,
  type ChatMessage,
  type CompletionResponse,
  type HeldToolCall,
  type StandardSchemaV1,
  type ToolCall,
  type ToolMeta,
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

const callOf = (id: string, name = id): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: "{}" }
})

const toolsetOf = (
  metas: ReadonlyArray<Omit<ToolMeta, "name"> & { readonly name: string }>,
  execute: Toolset["execute"]
): Toolset => ({
  entries: () => metas.map((meta) => ({ description: meta.name, parameters: {}, meta })),
  loadedNames: () => new Set(),
  load: () => undefined,
  execute
})

const scripted = (calls: ReadonlyArray<ToolCall>, requests: Array<ReadonlyArray<ChatMessage>>) => ({
  protocolVersion: 1 as const,
  stream: (request: { readonly messages: ReadonlyArray<ChatMessage> }) => {
    requests.push(structuredClone([...request.messages]))
    return [requests.length === 1 ? response(calls, "") : response()]
  }
})

const toolMessages = (messages: ReadonlyArray<ChatMessage>) =>
  messages.flatMap((message) =>
    message.role === "tool"
      ? [{ id: message.tool_call_id, content: message.content, launch: message.async_tool_launch }]
      : []
  )

const deliveries = (messages: ReadonlyArray<ChatMessage>) =>
  messages.flatMap((message) =>
    message.client_id?.startsWith("async-result:") === true && Array.isArray(message.content)
      ? message.content.map((block) => ({ id: message.client_id, content: block.content }))
      : []
  )

const flushTimers = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

it("a call that settles within the budget returns its result inline", async () => {
  const requests: Array<ReadonlyArray<ChatMessage>> = []
  const result = await makeAgent(
    { model: "test", foregroundBudgetMs: 60_000 },
    {
      provider: scripted([callOf("lookup")], requests),
      toolset: toolsetOf([{ name: "lookup" }], async () => ({ content: "found", preview: "ok" }))
    }
  ).run([{ role: "user", content: "Go" }])
  expect(toolMessages(result.messages)).toEqual([
    { id: "lookup", content: "found", launch: undefined }
  ])
  expect(deliveries(result.messages)).toEqual([])
})

it("a call still running at the budget gives the model a receipt and delivers its result once, later", async () => {
  const finish = deferred()
  let executions = 0
  const completed: string[] = []
  const requests: Array<ReadonlyArray<ChatMessage>> = []
  const agent = makeAgent(
    { model: "test", foregroundBudgetMs: 0, maxIterations: 8 },
    {
      provider: {
        protocolVersion: 1,
        stream: (request) => {
          requests.push(structuredClone([...request.messages]))
          if (requests.length === 1) return [response([callOf("slow")], "")]
          if (requests.length === 2) {
            finish.resolve()
            return [response([], "Independent work")]
          }
          return [response()]
        }
      },
      toolset: toolsetOf([{ name: "slow" }], async () => {
        executions += 1
        await finish.promise
        return { content: "slow result", preview: "ok" }
      })
    }
  )
  for await (const event of agent.stream([{ role: "user", content: "Go" }]))
    if ("_tag" in event && event._tag === "ToolCompleted") completed.push(event.tool_id)
  expect(toolMessages(requests[1] ?? [])).toEqual([
    {
      id: "slow",
      content: expect.stringContaining('"status":"running"'),
      launch: { call_id: "slow", delivery: "message" }
    }
  ])
  expect(executions).toBe(1)
  expect(completed).toEqual(["slow"])
  expect(deliveries(requests[2] ?? [])).toEqual([
    { id: "async-result:slow", content: "slow result" }
  ])
})

it("moving a state change to the background lets the next one start; a later write in its group still waits", async () => {
  const finish = deferred()
  const otherRan = deferred()
  const executed: string[] = []
  const running = makeAgent(
    { model: "test", foregroundBudgetMs: 0, maxIterations: 8 },
    {
      provider: scripted(
        [callOf("slow_write"), callOf("other_write"), callOf("same_group_write")],
        []
      ),
      toolset: toolsetOf(
        [
          { name: "slow_write", changes_state: true, concurrency_group: "files" },
          { name: "other_write", changes_state: true },
          { name: "same_group_write", changes_state: true, concurrency_group: "files" }
        ],
        async (request) => {
          executed.push(request.name)
          if (request.name === "slow_write") await finish.promise
          if (request.name === "other_write") otherRan.resolve()
          return { content: `${request.name} done`, preview: "ok" }
        }
      )
    }
  ).run([{ role: "user", content: "Go" }])
  await otherRan.promise
  await flushTimers()
  const whileSlowRuns = [...executed]
  finish.resolve()
  const result = await running
  expect(whileSlowRuns).toEqual(["slow_write", "other_write"])
  expect(executed).toEqual(["slow_write", "other_write", "same_group_write"])
  expect(deliveries(result.messages)).toEqual([
    { id: "async-result:slow_write", content: "slow_write done" }
  ])
})

it("a call waiting on its approval gate never moves to the background, and the state change after it waits", async () => {
  const gateEntered = deferred()
  const review = deferred()
  const executed: string[] = []
  const running = makeAgent(
    { model: "test", foregroundBudgetMs: 0 },
    {
      provider: scripted([callOf("send"), callOf("note")], []),
      toolset: toolsetOf(
        [
          { name: "send", changes_state: true },
          { name: "note", changes_state: true }
        ],
        async (request) => {
          executed.push(request.name)
          if (request.name === "note") return { content: "noted", preview: "ok" }
          request.phase?.("waiting")
          gateEntered.resolve()
          await review.promise
          throw new PauseRequested("approval", "Send it?")
        }
      )
    }
  ).run([{ role: "user", content: "Go" }])
  await gateEntered.promise
  await flushTimers()
  const duringReview = [...executed]
  review.resolve()
  const result = await running
  expect(duringReview).toEqual(["send"])
  expect(executed).toEqual(["send", "note"])
  expect(result.stop_reason).toBe("paused")
  expect(result.paused_tools.map((tool) => tool.name)).toEqual(["send"])
  expect(toolMessages(result.messages).some((message) => message.launch !== undefined)).toBe(false)
})

it("a restart while a backgrounded call runs recovers its outcome like any background call", async () => {
  const stop = new AbortController()
  const checkpoints: Array<ReadonlyArray<ChatMessage>> = []
  await expect(
    makeAgent(
      { model: "test", foregroundBudgetMs: 0 },
      {
        provider: {
          protocolVersion: 1,
          stream: () => {
            if (checkpoints.length === 0) return [response([callOf("write")], "")]
            stop.abort()
            return [response([], "never")]
          }
        },
        toolset: toolsetOf([{ name: "write", changes_state: true }], () => new Promise(() => {})),
        hooks: {
          onStepFinish: (_step, _response, messages) => {
            checkpoints.push(structuredClone([...messages]))
          }
        }
      }
    ).run([{ role: "user", content: "Go" }], { signal: stop.signal })
  ).rejects.toThrow()
  const saved = checkpoints.at(-1) ?? []
  const result = await makeAgent(
    { model: "test" },
    {
      provider: { protocolVersion: 1, stream: () => [response()] },
      toolset: toolsetOf([{ name: "write", changes_state: true }], () => {
        throw new Error("a recovered call must not run again")
      }),
      hooks: {
        claimBackgroundCalls: () => new Map(),
        recoverToolCalls: (calls) =>
          new Map(calls.map((call) => [call.toolCall.id, { content: "uncertain", preview: "?" }]))
      }
    }
  ).run(saved)
  expect(deliveries(result.messages)).toEqual([{ id: "async-result:write", content: "uncertain" }])
  expect(result.stop_reason).toBe("end_turn")
})

const noArgs: StandardSchemaV1<unknown, Readonly<Record<string, never>>> = {
  "~standard": { version: 1, vendor: "test", validate: () => ({ value: {} }) }
}

it("a tool that declares nothing about the background, like an MCP tool, moves there when slow", async () => {
  const finish = deferred()
  const requests: Array<ReadonlyArray<ChatMessage>> = []
  const mcp = createTool({
    name: "mcp__runpod__stream_logs",
    description: "Stream pod logs",
    parameters: noArgs,
    metadata: { changes_state: true, concurrency_group: "mcp:runpod" },
    execute: async () => {
      await finish.promise
      return "logs"
    }
  })
  const result = await makeAgent(
    { model: "test", foregroundBudgetMs: 0, maxIterations: 8 },
    {
      provider: {
        protocolVersion: 1,
        stream: (request) => {
          requests.push(structuredClone([...request.messages]))
          if (requests.length === 1) return [response([callOf("logs", mcp.definition.name)], "")]
          finish.resolve()
          return [response()]
        }
      },
      toolset: createToolset([mcp], { toJsonSchema: () => ({ type: "object" }) })(undefined)
    }
  ).run([{ role: "user", content: "Go" }])
  expect(toolMessages(requests[1] ?? []).map((message) => message.launch)).toEqual([
    { call_id: "logs", delivery: "message" }
  ])
  expect(deliveries(result.messages)).toEqual([{ id: "async-result:logs", content: "logs" }])
})

it("a pause is emitted at once while a background call runs on, and the resumed run delivers its result once", async () => {
  const finish = deferred()
  const longDone = deferred()
  const outcomes = new Map<string, { content: string; preview: string }>()
  let longRuns = 0
  let longSignal: AbortSignal | undefined
  let asked = false
  const tools = toolsetOf(
    [{ name: "long" }, { name: "ask", changes_state: true }],
    async (request) => {
      if (request.name === "ask") {
        if (!asked) {
          asked = true
          throw new PauseRequested("approval", "Allow?")
        }
        return { content: "asked", preview: "ok" }
      }
      longRuns += 1
      longSignal = request.signal
      await finish.promise
      outcomes.set(request.toolCallId, { content: "long result", preview: "ok" })
      longDone.resolve()
      return { content: "long result", preview: "ok" }
    }
  )
  const paused = await makeAgent(
    { model: "test", foregroundBudgetMs: 0 },
    { provider: scripted([callOf("long"), callOf("ask")], []), toolset: tools }
  ).run([{ role: "user", content: "Go" }])
  const pausedWhileRunning = longRuns === 1 && outcomes.size === 0
  finish.resolve()
  await longDone.promise
  const resumed = await makeAgent(
    { model: "test" },
    {
      provider: { protocolVersion: 1, stream: () => [response()] },
      toolset: tools,
      hooks: {
        recoverToolCalls: (calls) =>
          new Map(
            calls.flatMap((call) => {
              const outcome = outcomes.get(call.toolCall.id)
              return outcome === undefined ? [] : [[call.toolCall.id, outcome] as const]
            })
          )
      }
    }
  ).run(paused.messages)
  expect(paused.stop_reason).toBe("paused")
  expect(pausedWhileRunning).toBe(true)
  expect(longSignal?.aborted).toBe(false)
  expect(longRuns).toBe(1)
  expect(deliveries(resumed.messages)).toEqual([
    { id: "async-result:long", content: "long result" }
  ])
  expect(resumed.stop_reason).toBe("end_turn")
})

it("a moved call that later asks for approval pauses the run, and the resumed run runs it from its receipt", async () => {
  const finish = deferred()
  let runs = 0
  const tools = toolsetOf([{ name: "slow", changes_state: true }], async () => {
    runs += 1
    if (runs === 1) {
      await finish.promise
      throw new PauseRequested("approval", "Allow the rest?")
    }
    return { content: "done", preview: "ok" }
  })
  const paused = await makeAgent(
    { model: "test", foregroundBudgetMs: 0, maxIterations: 8 },
    {
      provider: {
        protocolVersion: 1,
        stream: (request) => {
          if (!request.messages.some((message) => message.role === "tool"))
            return [response([callOf("slow")], "")]
          finish.resolve()
          return [response([], "Waiting on it")]
        }
      },
      toolset: tools
    }
  ).run([{ role: "user", content: "Go" }])
  const resumed = await makeAgent(
    { model: "test" },
    { provider: { protocolVersion: 1, stream: () => [response()] }, toolset: tools }
  ).run(paused.messages)
  expect(paused.stop_reason).toBe("paused")
  expect(paused.paused_tools.map((tool) => tool.name)).toEqual(["slow"])
  expect(toolMessages(paused.messages).map((message) => message.launch)).toEqual([
    { call_id: "slow", delivery: "message" }
  ])
  expect(runs).toBe(2)
  expect(deliveries(resumed.messages)).toEqual([{ id: "async-result:slow", content: "done" }])
})

const pausedBesideLongCall = async () => {
  const finish = deferred()
  const held = new Map<string, HeldToolCall>()
  let longRuns = 0
  let longSignal: AbortSignal | undefined
  let asked = false
  const tools = toolsetOf(
    [{ name: "long" }, { name: "ask", changes_state: true }],
    async (request) => {
      if (request.name === "ask") {
        if (asked) return { content: "asked", preview: "ok" }
        asked = true
        throw new PauseRequested("approval", "Allow?")
      }
      longRuns += 1
      longSignal = request.signal
      await finish.promise
      return { content: "long result", preview: "ok" }
    }
  )
  const paused = await makeAgent(
    { model: "test", foregroundBudgetMs: 0 },
    {
      provider: scripted([callOf("long"), callOf("ask")], []),
      toolset: tools,
      hooks: {
        holdBackgroundCalls: (calls) => {
          for (const call of calls) held.set(call.toolCallId, call)
        }
      }
    }
  ).run([{ role: "user", content: "Go" }])
  return {
    paused,
    tools,
    held,
    finish,
    longRuns: () => longRuns,
    longSignal: () => longSignal
  }
}

it("approving while a held background call still runs delivers its result once, never as uncertain", async () => {
  const setup = await pausedBesideLongCall()
  const resumed = makeAgent(
    { model: "test" },
    {
      provider: { protocolVersion: 1, stream: () => [response()] },
      toolset: setup.tools,
      hooks: {
        claimBackgroundCalls: (ids) =>
          new Map(
            ids.flatMap((id) => {
              const call = setup.held.get(id)
              return call === undefined ? [] : [[id, call] as const]
            })
          ),
        recoverToolCalls: (calls) =>
          new Map(calls.map((call) => [call.toolCall.id, { content: "uncertain", preview: "?" }]))
      }
    }
  ).run(setup.paused.messages)
  setup.finish.resolve()
  const result = await resumed
  expect([...setup.held.keys()]).toEqual(["long"])
  expect(setup.longRuns()).toBe(1)
  expect(deliveries(result.messages)).toEqual([{ id: "async-result:long", content: "long result" }])
  expect(result.stop_reason).toBe("end_turn")
})

it("stopping a paused run aborts the background calls its pause left running", async () => {
  const setup = await pausedBesideLongCall()
  const runningAtPause = setup.longSignal()?.aborted
  for (const call of setup.held.values()) call.stop()
  expect(setup.paused.stop_reason).toBe("paused")
  expect(runningAtPause).toBe(false)
  expect(setup.longSignal()?.aborted).toBe(true)
})

it("a pause whose host fails to hold its running background calls stops them", async () => {
  const finish = deferred()
  let longSignal: AbortSignal | undefined
  const tools = toolsetOf(
    [{ name: "long" }, { name: "ask", changes_state: true }],
    async (request) => {
      if (request.name === "ask") throw new PauseRequested("approval", "Allow?")
      longSignal = request.signal
      await finish.promise
      return { content: "long result", preview: "ok" }
    }
  )
  const run = makeAgent(
    { model: "test", foregroundBudgetMs: 0 },
    {
      provider: scripted([callOf("long"), callOf("ask")], []),
      toolset: tools,
      hooks: {
        holdBackgroundCalls: () => {
          throw new Error("registry unavailable")
        }
      }
    }
  ).run([{ role: "user", content: "Go" }])
  await expect(run).rejects.toThrow("holdBackgroundCalls failed: registry unavailable")
  finish.resolve()
  expect(longSignal?.aborted).toBe(true)
})
