import { expect, it } from "vitest"

import { ToolExecutionError } from "@arden-hq/loop"
import type { Schema } from "effect"

import { executeCodeMode } from "../src/workflows/runtime/code-mode-runtime.js"
import { executeScript } from "../src/workflows/runtime/script-runtime.js"

const signal = (): AbortSignal => new AbortController().signal

it("composes dependent tool calls and returns one compact JSON value", async () => {
  const outcome = await executeCodeMode({
    code: `
      const first = await tools.call("lookup", { id: 2 });
      const second = await tools.call("lookup", { id: first.value });
      return { answer: second.value };
    `,
    signal: signal(),
    call: async ({ args }) => ({ value: Number(args["id"]) * 2 })
  })

  expect(outcome).toEqual({
    status: "completed",
    value: { answer: 8 },
    calls: ["lookup", "lookup"]
  })
})

it("bounds concurrent calls while supporting Promise.all", async () => {
  let active = 0
  let maximum = 0
  const outcome = await executeCodeMode({
    code: `
      const values = await Promise.all(
        Array.from({ length: 8 }, (_, id) => tools.call("lookup", { id }))
      );
      return values.map(({ id }) => id);
    `,
    signal: signal(),
    maxConcurrency: 3,
    call: async ({ args }) => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return { id: args["id"] ?? null }
    }
  })

  expect(outcome.status).toBe("completed")
  expect(maximum).toBe(3)
})

it("rejects unavailable host powers and non-JSON results", async () => {
  const isolated = await executeCodeMode({
    code: `return {
      process: typeof process,
      require: typeof require,
      fetch: typeof fetch,
      date: typeof Date,
      console: typeof console
    }`,
    signal: signal(),
    call: async () => null
  })
  const invalid = await executeCodeMode({
    code: "return () => 1",
    signal: signal(),
    call: async () => null
  })

  expect(isolated).toMatchObject({
    status: "completed",
    value: {
      process: "undefined",
      require: "undefined",
      fetch: "undefined",
      date: "undefined",
      console: "undefined"
    }
  })
  expect(invalid).toMatchObject({
    status: "failed",
    error: "Code Mode result must be JSON-serializable"
  })
})

it("enforces call and wall-clock budgets", async () => {
  const calls = await executeCodeMode({
    code: `
      for (let index = 0; index < 13; index += 1) {
        await tools.call("lookup", { index });
      }
      return "unreachable";
    `,
    signal: signal(),
    call: async () => null
  })
  const timeout = await executeCodeMode({
    code: "while (true) {}",
    signal: signal(),
    timeoutMs: 20,
    call: async () => null
  })

  expect(calls).toMatchObject({
    status: "failed",
    error: "Code Mode allows at most 12 tool calls"
  })
  expect(timeout).toEqual({
    status: "failed",
    error: "Code Mode timed out after 20ms",
    reason: "timed_out",
    calls: []
  })
})

it("keeps a failed tool's plain line on the script failure it caused", async () => {
  const outcome = await executeScript({
    code: `await tools.call("browser_act", { action: "fill" }); return "done";`,
    args: {},
    parentToolCallId: "call-1",
    signal: signal(),
    executionProfileHash: "profile",
    agent: async () => null,
    tool: async () => {
      throw new ToolExecutionError(
        "The browser action was dispatched but its outcome is unknown.",
        {
          preview: "A step in the browser didn't confirm it finished",
          retryable: false
        }
      )
    }
  })

  expect(outcome.status).toBe("failed")
  if (outcome.status !== "failed") return
  expect(outcome.error.message).toContain(
    "The browser action was dispatched but its outcome is unknown."
  )
  expect(outcome.error.preview).toBe("A step in the browser didn't confirm it finished")
})

it("gives a failure the script raised itself no tool line", async () => {
  const outcome = await executeScript({
    code: `throw new Error("stop");`,
    args: {},
    parentToolCallId: "call-1",
    signal: signal(),
    executionProfileHash: "profile",
    agent: async () => null,
    tool: async () => null
  })

  expect(outcome.status).toBe("failed")
  if (outcome.status !== "failed") return
  expect(outcome.error.preview).toBeUndefined()
})

it("names a script's syntax error and a thrown plain object in readable text", async () => {
  const syntax = await executeCodeMode({
    code: "return [{ prompt: 'don't' }]",
    signal: signal(),
    call: async () => null
  })
  const thrown = await executeCodeMode({
    code: "throw { problem: 'quota' }",
    signal: signal(),
    call: async () => null
  })
  expect([syntax, thrown]).toMatchObject([
    { status: "failed", error: expect.stringMatching(/^SyntaxError: /) },
    { status: "failed", error: '{"problem":"quota"}' }
  ])
})

const runScript = (
  code: string,
  agent: (prompt: string, logicalKey: string) => Promise<Schema.Json> = async (prompt) =>
    `${prompt} done`
) =>
  executeScript({
    code,
    args: {},
    parentToolCallId: "call-1",
    signal: signal(),
    executionProfileHash: "profile",
    agent: (request) => agent(request.prompt, request.logicalKey),
    tool: async ({ args }) => args
  })

it("keeps branch names through a replay without changing any call id", async () => {
  const body = (fanOut: string) => `
    const results = await parallel(${fanOut});
    await tools.call("record", { results });
    return results;
  `
  const journal = new Map<string, Schema.Json>()
  const keys: string[][] = []
  const run = async (code: string) => {
    const seen: string[] = []
    const ids: string[] = []
    const outcome = await executeScript({
      code,
      args: {},
      parentToolCallId: "call-1",
      signal: signal(),
      executionProfileHash: "profile",
      agent: async (request) => {
        seen.push(request.logicalKey)
        const stored = journal.get(request.logicalKey) ?? `${request.prompt} findings`
        journal.set(request.logicalKey, stored)
        return stored
      },
      tool: async ({ toolCallId }) => {
        ids.push(toolCallId)
        return null
      }
    })
    keys.push(seen)
    return { outcome, ids }
  }

  const unnamed = await run(body(`[() => agent("a"), () => agent("b")]`))
  const first = await run(body(`{ Alpha: () => agent("a"), Beta: () => agent("b") }`))
  const replay = await run(body(`{ Alpha: () => agent("a"), Beta: () => agent("b") }`))

  expect(new Set(keys.map((list) => JSON.stringify([...list].sort()))).size).toBe(1)
  expect(journal.size).toBe(2)
  expect(replay.outcome).toEqual(first.outcome)
  expect(replay.ids).toEqual(first.ids)
  expect(first.outcome.status === "completed" && first.outcome.value).toEqual({
    Alpha: { kind: "workflow_branch", name: "Alpha", status: "succeeded", value: "a findings" },
    Beta: { kind: "workflow_branch", name: "Beta", status: "succeeded", value: "b findings" }
  })
  expect(unnamed.outcome.status).toBe("completed")
})

it("retains phase occurrences and exact child attempts despite duplicate agent labels", async () => {
  const progress: import("../src/workflows/runtime/script-runtime.js").ScriptProgress[] = []
  const outcome = await executeScript({
    code: `phase("Review"); await agent("first", { label: "Reviewer" });
      phase("Review"); await agent("second", { label: "Reviewer" });
      await agent("third", { phase: "Report", label: "Reviewer" }); return "done";`,
    args: {},
    parentToolCallId: "call-1",
    signal: signal(),
    executionProfileHash: "profile",
    tool: async () => null,
    agent: async (request, observer) => {
      await observer.recordChildAttempt({
        status: "succeeded",
        attempt: 1,
        schemaAttempt: 1,
        restartAttempt: 0,
        parentRunId: "origin",
        parentToolCallId: `spawn-${request.index}`,
        child: { sessionRef: `child-${request.index}`, runId: `run-${request.index}` }
      })
      return request.prompt
    },
    onProgress: (value) => progress.push(value)
  })
  expect(outcome.status).toBe("completed")
  expect(outcome.phases).toEqual(["Review", "Review", "Report"])
  const last = progress.at(-1)
  expect(last?.agents.map((agent) => agent.phase_id)).toEqual([
    "phase:0",
    "phase:1",
    "override:Report"
  ])
  expect(new Set(last?.agents.map((agent) => agent.key)).size).toBe(3)
  expect(last?.agents.map((agent) => agent.child_attempts)).toEqual(
    [0, 1, 2].map((index) => [
      {
        status: "succeeded",
        attempt: 1,
        schemaAttempt: 1,
        restartAttempt: 0,
        parentRunId: "origin",
        parentToolCallId: `spawn-${index}`,
        child: { sessionRef: `child-${index}`, runId: `run-${index}` }
      }
    ])
  )
})

it("puts what a nested call read and changed on its trace entry", async () => {
  const sourceRefs = [
    { provider: "file", kind: "file", ref: "/repo/README.md", title: "README.md" }
  ]
  const changeEvidence = { operation_id: "tool-call:run:call-1:code", entries: [] }
  const reports: Array<ReadonlyArray<object>> = []
  const outcome = await executeScript({
    code: `await tools.call("file_read", { path: "README.md" }); await tools.call("other", {}); return "done";`,
    onProgress: (progress) => reports.push(progress.tools),
    args: {},
    parentToolCallId: "call-1",
    signal: signal(),
    executionProfileHash: "profile",
    agent: async () => null,
    tool: async ({ name, onSettled }) => {
      if (name === "file_read")
        onSettled({ source_refs: sourceRefs, change_evidence: changeEvidence })
      return { content: "text", preview: "Read", data: { text: "body" } }
    }
  })

  expect(outcome.status).toBe("completed")
  if (outcome.status !== "completed") return
  expect(reports.filter((tools) => tools.some((tool) => "source_refs" in tool))).toHaveLength(1)
  expect(outcome.tools).toMatchObject([
    {
      name: "file_read",
      status: "completed",
      source_refs: sourceRefs,
      change_evidence: changeEvidence
    },
    { name: "other", status: "completed" }
  ])
})
