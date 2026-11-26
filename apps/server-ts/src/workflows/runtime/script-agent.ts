import { AGENT_MODE } from "@arden-hq/protocol/chat"
import { ToolExecutionError } from "@arden-hq/loop"
import { Schema } from "effect"

import { scriptAgentKey } from "../../persistence/workflows/script-identity.js"
import type { ScriptAgentObserver, ScriptAgentRequest } from "./contract.js"
import { workflowNodeIdentity } from "../identity.js"
import { isJsonObject } from "./nested-trace.js"
import { errorMessage } from "@arden-hq/std/errors"
import { type ScriptError, type ScriptProgressAgent } from "./script-outcome.js"
import { type ScriptRun, ScriptLaunchBudgetError, optionalBoundedText } from "./script-run.js"

export const runScriptAgent = (
  run: ScriptRun,
  index: number,
  args: Readonly<Record<string, Schema.Json>>,
  signal: AbortSignal
): Promise<Schema.Json> => {
  const { options, reserveLaunch, launches, progressAgents, emitProgress, registerPhase } = run
  const prompt = args["prompt"]
  const mode = args["mode"]
  const model = args["model"]
  const reasoningEffort = args["reasoningEffort"]
  const label = args["label"]
  const key = args["key"]
  const occurrence = args["occurrence"]
  const phase = args["phase"]
  const schema = args["schema"]
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return Promise.reject(new Error("agent prompt must not be empty"))
  }
  if (mode !== AGENT_MODE.research && mode !== AGENT_MODE.code && mode !== AGENT_MODE.work) {
    return Promise.reject(new Error("agent mode must be research, code or work"))
  }
  if (typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 0) {
    return Promise.reject(new Error("agent occurrence must be a natural number"))
  }
  const normalizedLabel = optionalBoundedText(label, "agent label", 200)
  const normalizedModel = optionalBoundedText(model, "agent model", 512)
  const normalizedReasoningEffort = optionalBoundedText(
    reasoningEffort,
    "agent reasoning effort",
    128
  )
  if (normalizedReasoningEffort !== undefined && normalizedModel === undefined) {
    return Promise.reject(new Error("agent reasoning_effort requires model"))
  }
  const normalizedKey = optionalBoundedText(key, "agent key", 256)
  const normalizedPhase = optionalBoundedText(phase, "agent phase", 200)
  const normalizedSchema = isJsonObject(schema) ? schema : undefined
  const identity = workflowNodeIdentity({
    prompt,
    mode,
    ...(normalizedModel === undefined ? {} : { model: normalizedModel }),
    ...(normalizedReasoningEffort === undefined
      ? {}
      : { reasoningEffort: normalizedReasoningEffort }),
    label: normalizedLabel,
    key: normalizedKey,
    phase: normalizedPhase,
    schema: normalizedSchema,
    occurrence,
    executionProfileHash: options.executionProfileHash
  })
  const agentRequest = {
    parentToolCallId: options.parentToolCallId,
    index,
    occurrence,
    logicalKey: identity.logicalKey,
    specificationHash: identity.specificationHash,
    prompt,
    mode,
    ...(normalizedModel === undefined ? {} : { model: normalizedModel }),
    ...(normalizedReasoningEffort === undefined
      ? {}
      : { reasoningEffort: normalizedReasoningEffort }),
    ...(normalizedLabel === undefined ? {} : { label: normalizedLabel }),
    ...(normalizedKey === undefined ? {} : { key: normalizedKey }),
    ...(normalizedPhase === undefined ? {} : { phase: normalizedPhase }),
    ...(normalizedSchema === undefined ? {} : { schema: normalizedSchema }),
    signal
  } satisfies ScriptAgentRequest
  const phaseId = typeof args["phase_id"] === "string" ? args["phase_id"] : null
  if (phaseId !== null && normalizedPhase !== undefined) registerPhase(phaseId, normalizedPhase)
  let progress: ScriptProgressAgent = {
    reused_tool_call_id: null,
    key: scriptAgentKey(identity.logicalKey, identity.specificationHash),
    phase_id: phaseId,
    child_attempts: [],
    index,
    label: agentRequest.label ?? agentRequest.phase ?? `Agent ${index + 1}`,
    phase: agentRequest.phase ?? "Workflow",
    mode,
    status: "running"
  } satisfies ScriptProgressAgent
  progressAgents.set(index, progress)
  emitProgress()
  const observer = {
    reserveLaunch,
    recordReuse: (toolCallId: string) => {
      progress = { ...progress, reused_tool_call_id: toolCallId }
      progressAgents.set(index, progress)
      emitProgress()
    },
    recordChildAttempt: (event) => {
      progress = {
        ...progress,
        child_attempts: [
          ...progress.child_attempts.filter(
            (prior) => prior.parentToolCallId !== event.parentToolCallId
          ),
          event
        ]
      }
      progressAgents.set(index, progress)
      emitProgress()
      return Promise.resolve()
    }
  } satisfies ScriptAgentObserver
  return options.agent(agentRequest, observer).then(
    (value) => {
      progressAgents.set(index, { ...progress, status: "completed" })
      emitProgress()
      return {
        kind: "script_agent_result",
        status: "succeeded",
        launches: launches.value,
        value
      } as const
    },
    (cause: unknown) => {
      progressAgents.set(index, { ...progress, status: "failed" })
      emitProgress()
      let code: ScriptError["code"] = "agent_failed"
      if (cause instanceof ScriptLaunchBudgetError) code = "budget_exhausted"
      else if (signal.aborted) code = "cancelled"
      return {
        kind: "script_agent_result",
        status: "failed",
        launches: launches.value,
        error: {
          code,
          message: errorMessage(cause, "Script agent failed"),
          retryable: cause instanceof ToolExecutionError && cause.retryable === true
        }
      } as const
    }
  )
}
