import { Schema } from "effect"
import { chatDecoders, chatRequests, chatRoutes } from "@arden-hq/protocol/chat"
import { runDecoders, runRoutes } from "@arden-hq/protocol/runs"
import type {
  CompletionResponse,
  ModelProvider,
  ModelProviderRequest,
  ToolResult,
  Toolset
} from "@arden-hq/loop"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { makeLoopChatRunner, startServer, type ServerHandle } from "../src/index.js"
import { decodeRow, decodeRows, present } from "./kit.js"

const headers = { "content-type": "application/json" }

const modelHost = {
  models: [
    {
      id: "fixture-model",
      name: "Fixture model",
      provider: { id: "fixture", name: "Fixture" },
      reasoningEfforts: [],
      context: { hardLimit: 128_000, compactionTrigger: 100_000 }
    }
  ],
  defaults: {
    chatModelId: "fixture-model",
    reasoningEfforts: {},
    roles: {
      background: { modelId: null, reasoningEffort: null },
      helper: { modelId: null, reasoningEffort: null }
    }
  }
} as const

const textReply = (request: ModelProviderRequest, content: string): CompletionResponse => ({
  _tag: "Completed",
  message: { role: "assistant", content, tool_calls: null, reasoning_content: null },
  finish_reason: "stop",
  usage: { prompt_tokens: 2, completion_tokens: 1 },
  model: request.model
})

const toolCallReply = (request: ModelProviderRequest): CompletionResponse => ({
  _tag: "Completed",
  message: {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call-slow-write",
        type: "function",
        function: { name: "slow-write", arguments: '{"value":"saved"}' }
      }
    ],
    reasoning_content: null
  },
  finish_reason: "tool_calls",
  usage: { prompt_tokens: 1, completion_tokens: 1 },
  model: request.model
})

const makeRig = (execute: (signal: AbortSignal) => Promise<ToolResult>) => {
  const requests: Array<ModelProviderRequest> = []
  let executions = 0
  const provider: ModelProvider = {
    protocolVersion: 1,
    stream: (request) => {
      requests.push(request)
      return [
        request.messages.some((message) => message.role === "tool")
          ? textReply(request, "Continued after the restart.")
          : toolCallReply(request)
      ]
    }
  }
  const entry = {
    description: "Write one value",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    meta: { name: "slow-write", changes_state: true }
  }
  const toolset: Toolset = {
    entries: () => [entry],
    metadata: (name) => (name === entry.meta.name ? entry.meta : undefined),
    loadedNames: () => new Set(),
    load: () => undefined,
    execute: async ({ signal }) => {
      executions += 1
      return execute(present(signal, "the call's abort signal"))
    }
  }
  return {
    requests,
    executions: () => executions,
    runner: makeLoopChatRunner({ provider, toolset })
  }
}

const RunRowSchema = Schema.Struct({
  status: Schema.String,
  stop_reason: Schema.NullOr(Schema.String),
  resumed: Schema.NullOr(Schema.String)
})

const readRun = (databasePath: string, runId: string) => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return {
      run: decodeRow(
        RunRowSchema,
        database
          .prepare(
            "SELECT status, stop_reason, json_extract(metadata_json, '$.resumed') AS resumed FROM chat_runs WHERE run_id = ?"
          )
          .get(runId)
      ),
      tool: decodeRow(
        Schema.UndefinedOr(
          Schema.Struct({ status: Schema.String, result_json: Schema.NullOr(Schema.String) })
        ),
        database
          .prepare(
            "SELECT status, result_json FROM tool_calls WHERE run_id = ? AND tool_call_id = 'call-slow-write'"
          )
          .get(runId)
      ),
      statuses: decodeRows(
        Schema.Struct({ status: Schema.String }),
        database
          .prepare(
            `SELECT json_extract(data_json, '$.status') AS status FROM journal_records
         WHERE json_extract(attributes_json, '$.runId') = ? AND event_type = 'thinking' ORDER BY sequence`
          )
          .all(runId)
      ).map((row) => row.status)
    }
  } finally {
    database.close()
  }
}

const startRun = async (server: ServerHandle): Promise<string> => {
  const session = (await (
    await server.fetch("/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Drain" })
    })
  ).json()) as { readonly session_id: string }
  const receipt = chatDecoders.receipt(
    await (
      await server.fetch(chatRoutes.message, {
        method: "POST",
        headers,
        body: chatRequests.message({ sessionId: session.session_id, message: "Save this" }).body
      })
    ).json()
  )
  if (receipt.runId === null) throw new Error("Chat receipt did not include a run id")
  return receipt.runId
}

const waitForStatus = (server: ServerHandle, runId: string, status: string) =>
  expect
    .poll(
      async () =>
        runDecoders.detail(await (await server.fetch(runRoutes.detail(runId))).json()).status,
      { timeout: 8_000 }
    )
    .toBe(status)

it(
  "drain lets the current tool finish, writes no terminal, and the run resumes after reopen",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-restart-drain-"))
    const databasePath = join(directory, "arden.db")
    let toolStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve
    })
    let toolFinished = false
    const { promise: toolMayFinish, resolve: finishTool } = Promise.withResolvers<void>()
    const rig = makeRig(async () => {
      toolStarted()
      await toolMayFinish
      toolFinished = true
      return { content: "saved", preview: "saved", is_error: false }
    })
    let server: ServerHandle | undefined
    try {
      server = await startServer({ port: 0, databasePath, runner: rig.runner, modelHost })
      const runId = await startRun(server)
      await started
      let drained = false
      const draining = server.drain({ toolSettleMs: 10_000, reason: "restart" }).then(() => {
        drained = true
      })
      await expect
        .poll(() => readRun(databasePath, runId).statuses, { timeout: 8_000 })
        .toEqual(["Finishing the current tool, then restarting"])
      expect(drained).toBe(false)
      finishTool()
      await draining
      expect(toolFinished).toBe(true)
      await server.stop()
      server = undefined

      const stopped = readRun(databasePath, runId)
      expect(stopped.run).toMatchObject({ status: "running", stop_reason: null, resumed: null })
      expect(stopped.tool?.status).toBe("completed")
      expect(stopped.statuses).toEqual(["Finishing the current tool, then restarting"])

      server = await startServer({ port: 0, databasePath, runner: rig.runner, modelHost })
      await waitForStatus(server, runId, "completed")
      const finished = readRun(databasePath, runId)
      expect(JSON.parse(finished.run.resumed ?? "[]")).toMatchObject([{ cause: "server_restart" }])
      expect(rig.executions()).toBe(1)
      expect(rig.requests).toHaveLength(2)
    } finally {
      await server?.stop().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  }
)

it(
  "a state-changing tool cut off by the stop resumes with a verify result instead of failing",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-restart-uncertain-"))
    const databasePath = join(directory, "arden.db")
    let toolStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve
    })
    const rig = makeRig(
      (signal) =>
        new Promise((_, reject) => {
          toolStarted()
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        })
    )
    let server: ServerHandle | undefined
    try {
      server = await startServer({ port: 0, databasePath, runner: rig.runner, modelHost })
      const runId = await startRun(server)
      await started
      await server.drain({ toolSettleMs: 100 })
      await server.stop()
      server = undefined
      expect(readRun(databasePath, runId).run).toMatchObject({
        status: "running",
        stop_reason: null
      })
      expect(readRun(databasePath, runId).tool?.status).toBe("running")

      server = await startServer({ port: 0, databasePath, runner: rig.runner, modelHost })
      await waitForStatus(server, runId, "completed")
      const finished = readRun(databasePath, runId)
      expect(finished.tool?.status).toBe("uncertain")
      expect(rig.executions()).toBe(1)
      const reply = rig.requests.at(-1)
      const toolMessage = reply?.messages.find((message) => message.role === "tool")
      expect(typeof toolMessage?.content === "string" ? toolMessage.content : "").toContain(
        "may or may not have taken effect"
      )
    } finally {
      await server?.stop().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  }
)

it(
  "a recovered uncertain mutation parks the next background mutation on a durable decision",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-restart-background-decision-"))
    const databasePath = join(directory, "arden.db")
    let toolStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve
    })
    let restarted = false
    let initialRequests = 0
    let requestsAfterRestart = 0
    let executions = 0
    const call = (request: ModelProviderRequest, id: string, name: string): CompletionResponse => ({
      _tag: "Completed",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id,
            type: "function",
            function: { name, arguments: '{"value":"saved"}' }
          }
        ],
        reasoning_content: null
      },
      finish_reason: "tool_calls",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      model: request.model
    })
    const provider: ModelProvider = {
      protocolVersion: 1,
      stream: (request) => {
        if (!restarted) {
          initialRequests += 1
          return [
            initialRequests === 1
              ? call(request, "call-slow-write", "slow-write")
              : textReply(request, "Waiting for the first write.")
          ]
        }
        requestsAfterRestart += 1
        return [
          requestsAfterRestart === 1
            ? call(request, "call-next-write", "next-write")
            : textReply(
                request,
                requestsAfterRestart === 2 ? "Waiting for the next write." : "Finished."
              )
        ]
      }
    }
    const entry = {
      description: "Write one value",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"]
      },
      meta: { name: "slow-write", changes_state: true }
    }
    const nextEntry = {
      description: entry.description,
      parameters: entry.parameters,
      meta: { name: "next-write", changes_state: true, background: true }
    }
    const toolset: Toolset = {
      entries: () => [entry, nextEntry],
      metadata: (name) => {
        if (name === entry.meta.name) return entry.meta
        if (name === nextEntry.meta.name) return nextEntry.meta
        return undefined
      },
      loadedNames: () => new Set(),
      load: () => undefined,
      execute: async ({ signal }) => {
        executions += 1
        if (executions > 1) return { content: "saved", preview: "saved", is_error: false }
        toolStarted()
        return new Promise((_, reject) => {
          present(signal, "the call's abort signal").addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true }
          )
        })
      }
    }
    const runner = makeLoopChatRunner({ provider, toolset })
    let server: ServerHandle | undefined
    try {
      server = await startServer({ port: 0, databasePath, runner, modelHost })
      const runId = await startRun(server)
      await started
      await server.drain({ toolSettleMs: 100 })
      await server.stop()
      server = undefined
      restarted = true

      server = await startServer({ port: 0, databasePath, runner, modelHost })
      const waitForOutcomeApproval = () =>
        expect
          .poll(
            () => {
              const database = new DatabaseSync(databasePath, { readOnly: true })
              try {
                return database
                  .prepare(
                    "SELECT kind, status FROM tool_approvals WHERE run_id = ? AND tool_call_id = 'call-slow-write'"
                  )
                  .get(runId)
              } finally {
                database.close()
              }
            },
            { timeout: 8_000 }
          )
          .toEqual({ kind: "tool_outcome", status: "pending" })
      await waitForOutcomeApproval()
      await waitForStatus(server, runId, "pending")
      expect(executions).toBe(1)
      await server.stop()
      server = undefined
      server = await startServer({ port: 0, databasePath, runner, modelHost })
      await waitForOutcomeApproval()
      await waitForStatus(server, runId, "pending")
      const resolution = await server.fetch(chatRoutes.toolResult, {
        method: "POST",
        headers,
        body: chatRequests.toolResult({
          runId,
          toolId: "call-slow-write",
          result: "It did not complete",
          approved: false
        })
      })
      expect(resolution.status).toBe(200)
      await waitForStatus(server, runId, "completed")
      expect(executions).toBe(2)
    } finally {
      await server?.stop().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  }
)

it(
  "a command the stop cut off is reported before the resumed run's first model step",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "arden-restart-terminal-notice-"))
    const databasePath = join(directory, "arden.db")
    let toolStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve
    })
    const rig = makeRig(async () => {
      toolStarted()
      return { content: "saved", preview: "saved", is_error: false }
    })
    let server: ServerHandle | undefined
    try {
      server = await startServer({ port: 0, databasePath, runner: rig.runner, modelHost })
      const runId = await startRun(server)
      await started
      await server.drain({ toolSettleMs: 3_000 })
      await server.stop()
      server = undefined

      const database = new DatabaseSync(databasePath, { readOnly: true })
      const { session_id: sessionId } = decodeRow(
        Schema.Struct({ session_id: Schema.String }),
        database.prepare("SELECT session_id FROM chat_runs WHERE run_id = ?").get(runId)
      )
      database.close()
      await writeFile(
        join(directory, "terminals.json"),
        JSON.stringify([
          {
            sessionId,
            toolCallId: "call-loop",
            id: 2,
            command: "for i in 1 2 3; do sleep 5; done",
            approvalMode: "safe",
            startedAt: Date.now()
          }
        ])
      )
      const before = rig.requests.length

      server = await startServer({ port: 0, databasePath, runner: rig.runner, modelHost })
      await waitForStatus(server, runId, "completed")
      const resumed = rig.requests[before]
      expect(
        resumed?.messages.some((message) => message.client_id === "terminal-restart:call-loop")
      ).toBe(true)
    } finally {
      await server?.stop().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  }
)
