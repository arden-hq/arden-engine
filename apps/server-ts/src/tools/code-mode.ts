import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError, type JsonObject, type ToolContext } from "@arden-hq/loop"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import type { ServerRunContext } from "./run-context.js"
import { CODE_MODE_TOOL } from "../persistence/tools/tool-roles.js"
import { errorMessage } from "@arden-hq/std/errors"
import { ScriptStore, type ScriptRecord } from "../persistence/scripts/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { scriptReference } from "../workflows/identity.js"
import type { ScriptAgentObserver, ScriptAgentRequest } from "../workflows/runtime/contract.js"
import {
  executeScript,
  type ScriptOutcome,
  type ScriptProgress
} from "../workflows/runtime/script-runtime.js"
import type { AdoptedScript } from "../workflows/script-attempt.js"
import {
  ScriptRunner,
  detachedScriptData,
  type ScriptProgressSnapshot
} from "../workflows/script-runner.js"

export interface CodeModeServices {
  readonly store: ScriptStore["Service"]
  readonly runner: ScriptRunner["Service"]
  readonly sessions: SessionQueries["Service"]
}

const startScript = async (
  services: CodeModeServices,
  ctx: ToolContext<ServerRunContext>,
  adopted: AdoptedScript,
  progress: ScriptProgressSnapshot
): Promise<ScriptRecord> => {
  const session = await Effect.runPromise(
    services.sessions.loadHistoryHeader(ctx.run.sessionId)
  ).catch(() => null)
  if (session === null) {
    throw new ToolExecutionError("The script's chat could not be resolved", {
      preview: "Script unavailable",
      retryable: true
    })
  }
  const record = await Effect.runPromise(
    services.store.create({
      ref: scriptReference({ originRunId: ctx.run.runId, originToolCallId: ctx.toolCallId }),
      originSessionRef: session.publicRef,
      originRunId: ctx.run.runId,
      originToolCallId: ctx.toolCallId,
      profileHash: ctx.run.scriptHost.executionProfile.hash
    })
  ).catch((cause: unknown) => {
    throw new ToolExecutionError(errorMessage(cause, "The script could not be stored"), {
      preview: "Script unavailable",
      retryable: true
    })
  })
  await Effect.runPromise(
    services.runner.start({
      record,
      binding: { run: ctx.run, host: ctx.run.scriptHost },
      adopted,
      progress
    })
  )
  return record
}

const INLINE_BUDGET_MS = 10_000
const DEFAULT_MAX_AGENTS = 100

const ParametersSchema = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80_000)).annotate({
    description: [
      "Deterministic JavaScript async-function body (1-80,000 characters).",
      "Injected APIs: tools.call, agent, parallel, pipeline, phase, log, args, and budget; return a JSON-safe value.",
      "Name parallel branches with an object keyed by what each covers; return the fan-out's result as is so the user sees each branch under its name."
    ].join(" ")
  }),
  args: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Json).annotate({
      description:
        "JSON values exposed through the top-level-frozen args object. Defaults to an empty object."
    })
  ),
  max_agents: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })).annotate({
      description: [
        "Total child-agent launch budget, not concurrency (1-1,000). Defaults to 100.",
        "Read budget.spent() and budget.remaining() inside code."
      ].join(" ")
    })
  )
})

type Agent = (request: ScriptAgentRequest, observer: ScriptAgentObserver) => Promise<Schema.Json>

type Settled =
  | { readonly kind: "settled"; readonly outcome: ScriptOutcome }
  | { readonly kind: "detach"; readonly reason: "agent" | "budget" }

const makeCodeModeTool = (services: CodeModeServices): ServerTool =>
  defineServerTool({
    name: CODE_MODE_TOOL,
    description: [
      "Run deterministic JavaScript that composes tools and agents. Use a script for three or more calls with logic between them, a fan-out over many items, or cutting a large output down to what matters. For one call whose output you need as is, call the tool directly.",
      "tools.call(name, args) resolves to { content, preview, data }. Use the bare tool name, such as tools.call('wiki_read_page', { ... }), never a prefix like functions. or space. content is text for the model and may carry line numbers or footers; never JSON.parse it. data is the structured result; for a text or JSON body, data.text is the raw body (web_fetch, file_read, wiki_read_page, browser_snapshot) and data.json is the parsed value when it is JSON; browser_act's data.page is the page after the action, with its snapshot_ref; session_read gives data.messages. describe(name) returns a tool's input schema.",
      "Not callable from a script: tools that start agents (agent_message, spawn_agent; use agent() instead) and tools that end the turn. Every call passes the normal approval gate. A call awaiting approval suspends the script; after the decision, it resumes with completed calls reused from their durable results. Keep writes few and deliberate; hand repetitive or bulk changes to an agent.",
      "agent(prompt, { mode, model, reasoning_effort, label, key, phase, schema }) starts a child agent. Its mode is research (the default) or code; use mode=code only when a child must edit files or run commands. Give repeated or mutating calls a stable key. Omit model for the Background model, or name an exact ID from model_catalog; reasoning_effort requires model.",
      "parallel(thunks) and pipeline(items, ...stages) return input-ordered { status, value | error } outcomes; a pipeline stage receives (value, index, originalItem). Pass an object instead of an array to name the branches: parallel({ Anthropic: () => agent(...), Meta: () => agent(...) }) returns an object under the same keys, each outcome carrying its name, and the user sees those names on the result. Name each branch by what it covers, in a few words.",
      "Call phase(title) before each step of a multi-step script; the title is what the user sees while it runs. log(message) adds a line to its record.",
      "A script runs in this turn. At its first agent() call, or after 10 seconds of work, it moves to the background: this call returns at once, the script keeps running, and its result arrives here automatically. Do not poll or wait for it.",
      "Globals: tools, describe, agent, parallel, pipeline, phase, log, args, budget, URL, plus standard JavaScript (JSON, Math, Map, Set, RegExp, Promise). No Date, timers, Math.random, console, network, filesystem, process, or modules. Return only the compact JSON result needed for the next step."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ParametersSchema),
    metadata: {
      display: { row: "code" },
      effect: "none",
      detached: true,
      code_mode: false,
      display_name: "Code Mode",
      kind: "code",
      action: "read",
      approval_preview: "Run several steps at once as a short script.",
      source: "_code",
      changes_state: false,
      concurrency_group: "code_mode",
      destructive: false,
      open_world: false,
      idempotent: true
    },
    execute: (input, ctx) => executeCodeMode(input, ctx, services)
  })

export const executeCodeMode = async (
  input: typeof ParametersSchema.Type,
  ctx: ToolContext<ServerRunContext>,
  services: CodeModeServices,
  options: { readonly lifecycle?: "caller" } = {}
): Promise<{ readonly result: string; readonly preview: string; readonly data: JsonObject }> => {
  const args = input.args ?? {}
  const maxAgents = input.max_agents ?? DEFAULT_MAX_AGENTS
  const script = new AbortController()
  const stopWithTurn = (): void => script.abort(ctx.signal.reason)
  if (ctx.signal.aborted) stopWithTurn()
  else ctx.signal.addEventListener("abort", stopWithTurn, { once: true })

  let detached = false
  let requestDetach: (reason: "agent" | "budget") => void = () => undefined
  const detach = new Promise<"agent" | "budget">((resolve) => {
    requestDetach = resolve
  })
  let attachAgent: (agent: Agent) => void = () => undefined
  const attached = new Promise<Agent>((resolve) => {
    attachAgent = resolve
  })
  let reported: ScriptProgress = { phases: [], agents: [], tools: [] }
  let progressSink = (progress: ScriptProgress): void => {
    void ctx.run
      .emitToolProgress({
        toolCallId: ctx.toolCallId,
        message: progressMessage(progress),
        data: inlineProgressData(progress)
      })
      .catch(() => undefined)
  }

  const outcome = executeScript({
    code: input.code,
    args,
    parentToolCallId: ctx.toolCallId,
    signal: script.signal,
    maxAgents,
    executionProfileHash: ctx.run.scriptHost.executionProfile.hash,
    onProgress: (progress) => {
      reported = progress
      progressSink(progress)
    },
    changesState: ctx.run.codeMode.changesState,
    describe: ctx.run.codeMode.describe,
    concurrencyGroup: ctx.run.codeMode.concurrencyGroup,
    tool: (request) =>
      ctx.run.codeMode.call({
        ...request,
        detached,
        messages: ctx.messages,
        ...(ctx.beforeExecute === undefined ? {} : { beforeExecute: ctx.beforeExecute })
      }),
    agent: async (request, observer) => {
      if (options.lifecycle === "caller")
        throw new ToolExecutionError("This script cannot start agents", {
          preview: "Agent unavailable",
          retryable: false
        })
      requestDetach("agent")
      return (await attached)(
        {
          ...request,
          ...(ctx.beforeExecute === undefined ? {} : { beforeExecute: ctx.beforeExecute })
        },
        observer
      )
    }
  })
  if (options.lifecycle === "caller") {
    try {
      return inlineResult(await outcome)
    } finally {
      ctx.signal.removeEventListener("abort", stopWithTurn)
    }
  }
  const budget = setTimeout(() => requestDetach("budget"), INLINE_BUDGET_MS)
  let first: Settled
  try {
    first = await Promise.race([
      outcome.then((settled): Settled => ({ kind: "settled", outcome: settled })),
      detach.then((reason): Settled => ({ kind: "detach", reason }))
    ])
  } catch (cause) {
    ctx.signal.removeEventListener("abort", stopWithTurn)
    throw cause
  } finally {
    clearTimeout(budget)
  }

  if (first.kind === "settled") {
    ctx.signal.removeEventListener("abort", stopWithTurn)
    return inlineResult(first.outcome)
  }

  detached = true
  ctx.signal.removeEventListener("abort", stopWithTurn)
  const adopted: AdoptedScript = {
    adopt: ({ agent, signal, onProgress }) => {
      if (signal.aborted) script.abort(signal.reason)
      else signal.addEventListener("abort", () => script.abort(signal.reason), { once: true })
      progressSink = onProgress
      attachAgent(agent)
      return outcome
    }
  }
  let record
  try {
    record = await startScript(services, ctx, adopted, { ...reported, logs: [] })
  } catch (cause) {
    script.abort(cause)
    throw cause
  }
  const reason =
    first.reason === "agent" ? "its first agent started" : "it passed 10 seconds of work"
  return {
    result:
      record.status === "running"
        ? `The script moved to the background because ${reason}. It keeps running as Workflow ${record.ref}; its result arrives here automatically. Do not poll or wait for it.`
        : `The script moved to the background as Workflow ${record.ref}, which is already ${record.status}; its result arrives here automatically.`,
    preview: "Moved to the background",
    data: detachedScriptData({
      workflowRef: record.ref,
      version: record.version,
      attempt: record.attempt,
      status: record.status,
      progress: { ...reported, tools: reported.tools.map(withoutCallFacts), logs: [] }
    })
  }
}

type StoredTraceEntry = Omit<ScriptProgress["tools"][number], "source_refs" | "change_evidence">

const withoutCallFacts = ({
  source_refs: _sources,
  change_evidence: _changes,
  ...tool
}: ScriptProgress["tools"][number]): StoredTraceEntry => tool

const inlineResult = (outcome: ScriptOutcome) => {
  if (outcome.status === "failed") {
    throw new ToolExecutionError(outcome.error.message, {
      preview: "Code Mode failed",
      retryable: false
    })
  }
  return {
    result: JSON.stringify(outcome.value, null, 2),
    preview: `${countOf(outcome.calls.length, "nested call")}`,
    data: {
      value: outcome.value,
      calls: outcome.calls,
      kind: "code_mode",
      phase_entries: [...outcome.phase_entries],
      phases: [...outcome.phases],
      tools: outcome.tools.map(withoutCallFacts),
      agents: [],
      logs: [...outcome.logs]
    }
  }
}

const progressMessage = (progress: ScriptProgress): string => {
  const phase = progress.phases.at(-1)
  if (phase !== undefined) return phase
  const done = progress.tools.filter((tool) => tool.status !== "running").length
  return `${done}/${progress.tools.length} calls done`
}

const inlineProgressData = (progress: ScriptProgress): JsonObject => ({
  kind: "code_mode",
  phase_entries: [...(progress.phase_entries ?? [])],
  phases: [...progress.phases],
  agents: progress.agents.map((agent) => ({ ...agent })),
  tools: progress.tools.map((tool) => ({ ...tool })),
  logs: []
})

export const codeModeTools = Effect.gen(function* () {
  return [
    makeCodeModeTool({
      store: yield* ScriptStore,
      runner: yield* ScriptRunner,
      sessions: yield* SessionQueries
    })
  ]
})
