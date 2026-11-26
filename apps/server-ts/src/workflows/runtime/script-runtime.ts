import { Schema } from "effect"

import {
  CODE_MODE_FRAME_LINES,
  CODE_MODE_RUNTIME_NAME,
  executeCodeMode,
  readableRuntimeError
} from "./code-mode-runtime.js"
import { CODE_MODE_FAILURE, CODE_MODE_STATUS } from "./code-mode-outcome.js"
import {
  SCRIPT_ENVELOPE_STATUS,
  SCRIPT_OUTCOME_STATUS,
  isScriptEnvelope,
  type ScriptError,
  type ScriptOutcome
} from "./script-outcome.js"
import { makeScriptRun, type ScriptOptions } from "./script-run.js"
import {
  SCRIPT_RPC_AGENT,
  SCRIPT_RPC_DESCRIBE,
  SCRIPT_RPC_PHASE,
  SCRIPT_RPC_TOOL,
  buildScript
} from "./script-source.js"
import { runScriptTool } from "./script-tool.js"
import { runScriptAgent } from "./script-agent.js"
import {
  MAX_PARALLEL_ITEMS,
  MAX_TOOL_CALLS,
  SCRIPT_OUTPUT_BYTES,
  SCRIPT_TIMEOUT_MS,
  failureMessage
} from "./script-run.js"

export const executeScript = async (options: ScriptOptions): Promise<ScriptOutcome> => {
  const run = makeScriptRun(options)
  const {
    maxAgents,
    progressAgents,
    progressTools,
    progressPhases,
    phaseEntries,
    registerPhase,
    emitProgress,
    toolCalls,
    halt,
    halted
  } = run
  let agentCount = 0
  const lineMarker = "\u0001"
  const newlinesBefore =
    buildScript(lineMarker, 0, maxAgents, run.argsJson).split(lineMarker)[0]?.match(/\n/g)
      ?.length ?? 0
  const code = buildScript(
    options.code,
    newlinesBefore + CODE_MODE_FRAME_LINES,
    maxAgents,
    run.argsJson
  )
  const outcome = await executeCodeMode({
    code,
    signal: AbortSignal.any([options.signal, halt.signal]),
    timeoutMs: options.timeoutMs ?? SCRIPT_TIMEOUT_MS,
    maxCalls: maxAgents + MAX_TOOL_CALLS + MAX_PARALLEL_ITEMS,
    maxConcurrency: maxAgents + MAX_TOOL_CALLS + MAX_PARALLEL_ITEMS,
    maxOutputBytes: SCRIPT_OUTPUT_BYTES,
    runtimeName: CODE_MODE_RUNTIME_NAME,
    call: ({ name, args, signal }) => {
      if (name === SCRIPT_RPC_PHASE) {
        const title = args["title"]
        const id = args["id"]
        if (typeof title === "string" && typeof id === "string") {
          registerPhase(id, title)
          emitProgress()
        }
        return Promise.resolve(null)
      }
      if (name === SCRIPT_RPC_DESCRIBE) return runDescribe(args)
      if (name === SCRIPT_RPC_TOOL) return runScriptTool(run, args, signal)
      if (name === SCRIPT_RPC_AGENT) return runScriptAgent(run, agentCount++, args, signal)
      return Promise.reject(new Error(`${name} is not available in Code Mode`))
    }
  })

  function runDescribe(request: Readonly<Record<string, Schema.Json>>): Promise<Schema.Json> {
    const name = request["name"]
    const description = typeof name === "string" ? options.describe?.(name) : undefined
    return description === undefined
      ? Promise.reject(new Error(`${String(name)} is not a tool Code Mode can call`))
      : Promise.resolve(description)
  }

  if (halted.value !== undefined) throw halted.value
  const agents = [...progressAgents.values()]
  if (outcome.status === CODE_MODE_STATUS.failed) {
    let code: ScriptError["code"] = "internal"
    if (outcome.reason === CODE_MODE_FAILURE.cancelled) code = "cancelled"
    else if (outcome.reason === CODE_MODE_FAILURE.timedOut) code = "timed_out"
    return {
      status: SCRIPT_OUTCOME_STATUS.failed,
      error: {
        code,
        message: outcome.error,
        retryable: outcome.reason !== CODE_MODE_FAILURE.cancelled
      },
      calls: toolCalls,
      logs: [],
      phases: [...progressPhases],
      agents
    }
  }
  if (!isScriptEnvelope(outcome.value)) {
    return {
      status: SCRIPT_OUTCOME_STATUS.failed,
      error: {
        code: "internal",
        message: "Code Mode returned an invalid envelope",
        retryable: true
      },
      calls: toolCalls,
      logs: [],
      phases: [...progressPhases],
      agents
    }
  }
  if (outcome.value.status === SCRIPT_ENVELOPE_STATUS.failed) {
    const { line, ...error } = outcome.value.error
    return {
      status: SCRIPT_OUTCOME_STATUS.failed,
      error: {
        ...error,
        message: failureMessage(readableRuntimeError(error.message), line, [
          ...progressTools.values()
        ])
      },
      calls: toolCalls,
      logs: outcome.value.logs,
      phases: [...progressPhases],
      agents
    }
  }
  return {
    status: SCRIPT_OUTCOME_STATUS.completed,
    phase_entries: [...phaseEntries.values()],
    value: outcome.value.value,
    calls: toolCalls,
    tools: [...progressTools.values()],
    logs: outcome.value.logs,
    phases: [...progressPhases]
  }
}
