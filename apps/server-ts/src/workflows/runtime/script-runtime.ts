import { makeFairReadWriteLock, PauseRequested, ToolExecutionError } from "@arden-hq/loop"
import { Schema } from "effect"

import { scriptAgentKey } from "../../persistence/workflows/script-identity.js"
import {
  CODE_MODE_FRAME_LINES,
  executeCodeMode,
  readableRuntimeError
} from "./code-mode-runtime.js"
import type {
  NestedCallFacts,
  ScriptAgentChildAttemptEvent,
  ScriptAgentMode,
  ScriptAgentObserver,
  ScriptAgentRequest
} from "./contract.js"
import { workflowNodeIdentity } from "../identity.js"
import {
  isJsonObject,
  nestedCallIds,
  PREVIEW_CHARS,
  resultPreview,
  trimmedArgs,
  type ScriptProgressTool
} from "./nested-trace.js"
import { CODE_MODE_TOOL, NESTED_CALL_MARKERS } from "../../persistence/tools/tool-roles.js"
import { errorMessage } from "@arden-hq/std/errors"

const DEFAULT_MAX_AGENTS = 100
const MAX_TOOL_CALLS = 1_000
const MAX_TOOL_CONCURRENCY = 4
const MAX_PARALLEL_ITEMS = 4_096
const MAX_BRANCH_NAME = 60
const SCRIPT_TIMEOUT_MS = 30 * 60 * 1_000
const SCRIPT_OUTPUT_BYTES = 8 * 1_024 * 1_024

const ScriptEnvelopeSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("succeeded"),
    value: Schema.Json,
    logs: Schema.Array(Schema.String),
    phases: Schema.Array(Schema.String)
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    error: Schema.Struct({
      code: Schema.Literals([
        "coordinator_failed",
        "agent_failed",
        "cancelled",
        "timed_out",
        "budget_exhausted",
        "internal"
      ] as const),
      message: Schema.String,
      retryable: Schema.Boolean,
      preview: Schema.optionalKey(Schema.String),
      line: Schema.optionalKey(Schema.Number)
    }),
    logs: Schema.Array(Schema.String),
    phases: Schema.Array(Schema.String)
  })
]).pipe(Schema.toTaggedUnion("status"))
const isScriptEnvelope = Schema.is(ScriptEnvelopeSchema)

interface ScriptToolRequest {
  readonly onResolved: (toolCallId: string) => void
  readonly onSettled: (facts: NestedCallFacts) => void
  readonly toolCallId: string
  readonly name: string
  readonly args: Readonly<Record<string, Schema.Json>>
  readonly phase?: string
  readonly signal: AbortSignal
}

export interface ScriptOptions {
  readonly code: string
  readonly args: Readonly<Record<string, Schema.Json>>
  readonly parentToolCallId: string
  readonly signal: AbortSignal
  readonly maxAgents?: number
  readonly executionProfileHash: string
  readonly timeoutMs?: number
  readonly agent: (
    request: ScriptAgentRequest,
    observer: ScriptAgentObserver
  ) => Promise<Schema.Json>
  readonly tool: (request: ScriptToolRequest) => Promise<Schema.Json>
  readonly changesState?: (name: string) => boolean
  readonly describe?: (name: string) => Schema.Json | undefined
  readonly concurrencyGroup?: ((name: string) => string | null) | undefined
  readonly onProgress?: (progress: ScriptProgress) => void
}

interface ScriptProgressAgent {
  readonly reused_tool_call_id: string | null
  readonly key: string
  readonly phase_id: string | null
  readonly child_attempts: ReadonlyArray<ScriptAgentChildAttemptEvent>
  readonly index: number
  readonly label: string
  readonly phase: string
  readonly mode: ScriptAgentMode
  readonly status: "running" | "completed" | "failed"
}

export interface ScriptProgress {
  readonly phase_entries?: ReadonlyArray<{ readonly id: string; readonly title: string }>
  readonly phases: ReadonlyArray<string>
  readonly agents: ReadonlyArray<ScriptProgressAgent>
  readonly tools: ReadonlyArray<ScriptProgressTool>
}

export type ScriptOutcome =
  | {
      readonly status: "completed"
      readonly phase_entries: NonNullable<ScriptProgress["phase_entries"]>
      readonly value: Schema.Json
      readonly calls: ReadonlyArray<string>
      readonly tools: ReadonlyArray<ScriptProgressTool>
      readonly logs: ReadonlyArray<string>
      readonly phases: ReadonlyArray<string>
    }
  | {
      readonly status: "failed"
      readonly error: ScriptError
      readonly calls: ReadonlyArray<string>
      readonly logs: ReadonlyArray<string>
      readonly phases: ReadonlyArray<string>
      readonly agents: ReadonlyArray<ScriptProgressAgent>
    }

interface ScriptError {
  readonly code:
    | "coordinator_failed"
    | "agent_failed"
    | "cancelled"
    | "timed_out"
    | "budget_exhausted"
    | "internal"
  readonly message: string
  readonly retryable: boolean
  readonly preview?: string
}

const groupLocks = () => {
  const locks = new Map<string, ReturnType<typeof makeFairReadWriteLock>>()
  return async <A>(
    group: string | null,
    options: { readonly write: boolean; readonly signal: AbortSignal },
    effect: () => Promise<A>
  ): Promise<A> => {
    if (group === null) return effect()
    const lock = locks.get(group) ?? makeFairReadWriteLock()
    locks.set(group, lock)
    const unlock = await lock.acquire(options.write)
    try {
      options.signal.throwIfAborted()
      return await effect()
    } finally {
      unlock()
    }
  }
}

class ScriptLaunchBudgetError extends Error {}

const limiter = (limit: number) => {
  let active = 0
  const waiting: Array<() => void> = []
  return async <A>(effect: () => Promise<A>): Promise<A> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    active += 1
    try {
      return await effect()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}

export const executeScript = async (options: ScriptOptions): Promise<ScriptOutcome> => {
  const maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS
  const argsJson = JSON.stringify(options.args)
  let launches = 0
  const reserveLaunch = (): number => {
    if (launches >= maxAgents) {
      throw new ScriptLaunchBudgetError("script child-launch budget exhausted")
    }
    launches += 1
    return launches
  }
  const progressAgents = new Map<number, ScriptProgressAgent>()
  const progressTools = new Map<string, ScriptProgressTool>()
  const progressPhases: string[] = []
  const phaseEntries = new Map<string, { readonly id: string; readonly title: string }>()
  const registerPhase = (id: string, title: string): void => {
    if (phaseEntries.has(id)) return
    phaseEntries.set(id, { id, title })
    progressPhases.push(title)
  }
  const unreported = new Set<string>()
  const emitProgress = (): void => {
    const tools = [...progressTools.values()].map((tool) => {
      if (unreported.has(tool.tool_call_id)) return tool
      const { source_refs: _sources, change_evidence: _changes, ...entry } = tool
      return entry
    })
    unreported.clear()
    options.onProgress?.({
      phase_entries: [...phaseEntries.values()],
      phases: [...progressPhases],
      agents: [...progressAgents.values()],
      tools
    })
  }
  let agentCount = 0
  const nestedCallId = nestedCallIds(options.parentToolCallId, NESTED_CALL_MARKERS[CODE_MODE_TOOL])
  const toolCalls: string[] = []
  const limitTools = limiter(MAX_TOOL_CONCURRENCY)
  const inGroup = groupLocks()
  const halt = new AbortController()
  let halted: PauseRequested | undefined
  const buildScript = (userCode: string, lineBase: number): string => `
    const __rpc = globalThis.tools.call;
    const __state = {
      phase: undefined,
      phaseId: null,
      phaseCount: 0,
      logs: [],
      phases: [],
      calls: 0,
      launches: 0,
      occurrences: new Map()
    };
    const __lineBase = ${lineBase};
    const __limit = ${maxAgents};
    const __maxItems = ${MAX_PARALLEL_ITEMS};
    const __maxBranchName = ${MAX_BRANCH_NAME};
    const args = Object.freeze(JSON.parse(${JSON.stringify(argsJson)}));
    const phase = (title) => {
      const value = String(title).trim();
      if (!value) throw new TypeError("phase title must not be empty");
      __state.phase = value;
      __state.phaseId = "phase:" + __state.phaseCount++;
      if (__state.phases[__state.phases.length - 1] !== value) __state.phases.push(value);
      __rpc("__script_phase", { title: value, id: __state.phaseId });
    };
    const log = (message) => {
      if (__state.logs.length >= 200) throw new Error("scripts allow at most 200 log entries");
      __state.logs.push(String(message).slice(0, 2000));
    };
    const describe = (name) => __rpc("__script_describe", { name: String(name) });
    const tools = Object.freeze({
      describe,
      call: async (name, callArgs = {}) => {
        if (typeof name !== "string") {
          throw new TypeError("tools.call expects the tool name as a string, got " + __show(name).slice(0, 200));
        }
        if (callArgs === null || typeof callArgs !== "object" || Array.isArray(callArgs)) {
          throw new TypeError("tools.call arguments for " + name + " must be an object, got " + __show(callArgs).slice(0, 200));
        }
        const response = await __rpc("__script_tool", {
          phase_id: __state.phaseId,
          name: String(name),
          args: callArgs,
          phase: __state.phase === undefined ? null : __state.phase
        });
        if (response && response.kind === "script_tool_result") {
          if (response.status === "succeeded") return response.value;
          const error = new Error(response.message);
          if (typeof response.preview === "string") error.preview = response.preview;
          throw error;
        }
        throw new Error("the tool returned an invalid host envelope");
      }
    });
    const agent = async (prompt, options = {}) => {
      if (__state.calls >= __limit) throw new Error("script agent-call budget exhausted");
      __state.calls += 1;
      const request = {
        prompt: String(prompt),
        mode: options.mode === "code" ? "code" : "research",
        model: options.model === undefined ? undefined : String(options.model),
        reasoningEffort: options.reasoning_effort === undefined ? undefined : String(options.reasoning_effort),
        label: options.label === undefined ? undefined : String(options.label),
        key: options.key === undefined ? undefined : String(options.key),
        phase: options.phase === undefined ? __state.phase : String(options.phase),
        schema: options.schema
      };
      const fingerprint = JSON.stringify(request);
      const occurrence = __state.occurrences.get(fingerprint) || 0;
      __state.occurrences.set(fingerprint, occurrence + 1);
      request.occurrence = occurrence;
      request.phase_id = options.phase === undefined ? __state.phaseId : "override:" + String(options.phase);
      const response = await __rpc("__script_agent", request);
      if (!response || response.kind !== "script_agent_result") {
        throw new Error("the agent returned an invalid host envelope");
      }
      __state.launches = response.launches;
      if (response.status === "succeeded") return response.value;
      const error = new Error(response.error.message);
      error.code = response.error.code;
      error.retryable = response.error.retryable;
      throw error;
    };
    const __show = (value) => {
      if (typeof value === "string") return value;
      if (typeof value === "function") return "[function " + (value.name || "anonymous") + "]";
      try {
        const json = JSON.stringify(value);
        if (json !== undefined) return json;
      } catch (_) {}
      try { return String(value); } catch (_) { return "[unprintable " + typeof value + "]"; }
    };
    const __describe = (error) => {
      if (error !== null && typeof error === "object" && typeof error.message === "string") {
        const name = typeof error.name === "string" && error.name !== "" && error.name !== "Error" ? error.name + ": " : "";
        return name + error.message;
      }
      return "script threw " + __show(error);
    };
    const __lineOf = (error) => {
      if (!error || typeof error.stack !== "string") return undefined;
      // The first frame inside the user's code; earlier lines are this prelude.
      for (const match of error.stack.matchAll(/eval\\.js:(\\d+)/g)) {
        const line = Number(match[1]) - __lineBase;
        if (line >= 1) return line;
      }
      return undefined;
    };
    const __branchError = (error) => ({
      code: "branch_failed",
      message: __describe(error).slice(0, 2000),
      retryable: Boolean(error && error.retryable === true)
    });
    const __named = (name) => name === undefined ? {} : { name };
    const __branchSucceeded = (value, name) => ({
      kind: "workflow_branch",
      ...__named(name),
      status: "succeeded",
      value
    });
    const __branchFailed = (error, name) => ({
      kind: "workflow_branch",
      ...__named(name),
      status: "failed",
      error: __branchError(error)
    });
    const __isBranchOutcome = (value) => value !== null && typeof value === "object" &&
      value.kind === "workflow_branch" &&
      (value.status === "succeeded" || value.status === "failed");
    // A fan-out takes an array, or an object whose keys name its branches. An
    // object comes back as an object under the same keys, an array as an array.
    const __entries = (input, api) => {
      if (Array.isArray(input)) {
        if (input.length > __maxItems) throw new TypeError(api + " accepts at most " + __maxItems + " entries");
        return { names: undefined, values: input };
      }
      if (input === null || typeof input !== "object") {
        throw new TypeError(api + " expects an array or an object of named entries");
      }
      const names = Object.keys(input);
      if (names.length > __maxItems) throw new TypeError(api + " accepts at most " + __maxItems + " entries");
      for (const name of names) {
        if (name.trim() === "") throw new TypeError(api + " branch names must not be empty");
        if (name !== name.trim()) {
          throw new TypeError(api + " branch name " + JSON.stringify(name) + " must not start or end with spaces");
        }
        if (name.length > __maxBranchName) {
          throw new TypeError(api + " branch name " + JSON.stringify(name) + " must be at most " + __maxBranchName + " characters");
        }
      }
      return { names, values: names.map((name) => input[name]) };
    };
    const __fanOut = async ({ names, values }, run) => {
      const outcomes = await Promise.all(values.map((value, index) => run(value, index, names && names[index])));
      return names === undefined
        ? outcomes
        : Object.fromEntries(names.map((name, index) => [name, outcomes[index]]));
    };
    const parallel = async (thunks) => {
      const entries = __entries(thunks, "parallel");
      const bad = entries.values.findIndex((thunk) => typeof thunk !== "function");
      if (bad !== -1) {
        const label = entries.names ? entries.names[bad] : "#" + bad;
        throw new TypeError("parallel entries must be functions that start the work, like () => tools.call(...); entry " + label + " is " + __show(entries.values[bad]).slice(0, 120) + ". Wrap it in () => ...");
      }
      return __fanOut(entries, async (thunk, _index, name) => {
        try { return __branchSucceeded(await thunk(), name); }
        catch (error) { return __branchFailed(error, name); }
      });
    };
    const pipeline = async (items, ...stages) => {
      const entries = __entries(items, "pipeline");
      if (stages.some((stage) => typeof stage !== "function")) {
        throw new TypeError("pipeline stages must be functions");
      }
      return __fanOut(entries, async (item, index, key) => {
        const outcome = __isBranchOutcome(item);
        // A branch keeps its name through later stages.
        const name = key !== undefined ? key : (outcome && typeof item.name === "string" ? item.name : undefined);
        if (outcome && item.status === "failed") return { ...item, ...__named(name) };
        try {
          let value = outcome ? item.value : item;
          for (const stage of stages) value = await stage(value, index, item);
          return __branchSucceeded(value, name);
        } catch (error) {
          return __branchFailed(error, name);
        }
      });
    };
    const budget = Object.freeze({
      total: __limit,
      spent: () => __state.launches,
      remaining: () => __limit - __state.launches
    });
    try {
      const __value = await (async () => { "use strict"; ${userCode}\n })();
      return {
        status: "succeeded",
        value: __value === undefined ? null : __value,
        logs: __state.logs,
        phases: __state.phases
      };
    } catch (error) {
      return {
        status: "failed",
        error: {
          code: error && typeof error.code === "string" ? error.code : "coordinator_failed",
          message: __describe(error).slice(0, 2000),
          retryable: Boolean(error && error.retryable === true),
          ...(__lineOf(error) === undefined ? {} : { line: __lineOf(error) }),
          ...(error && typeof error.preview === "string" ? { preview: error.preview.slice(0, 300) } : {})
        },
        logs: __state.logs,
        phases: __state.phases
      };
    }
  `
  const lineMarker = "\u0001"
  const newlinesBefore = buildScript(lineMarker, 0).split(lineMarker)[0]?.match(/\n/g)?.length ?? 0
  const code = buildScript(options.code, newlinesBefore + CODE_MODE_FRAME_LINES)
  const outcome = await executeCodeMode({
    code,
    signal: AbortSignal.any([options.signal, halt.signal]),
    timeoutMs: options.timeoutMs ?? SCRIPT_TIMEOUT_MS,
    maxCalls: maxAgents + MAX_TOOL_CALLS + MAX_PARALLEL_ITEMS,
    maxConcurrency: maxAgents + MAX_TOOL_CALLS + MAX_PARALLEL_ITEMS,
    maxOutputBytes: SCRIPT_OUTPUT_BYTES,
    runtimeName: "Code Mode",
    call: ({ name, args, signal }) => {
      if (name === "__script_phase") {
        const title = args["title"]
        const id = args["id"]
        if (typeof title === "string" && typeof id === "string") {
          registerPhase(id, title)
          emitProgress()
        }
        return Promise.resolve(null)
      }
      if (name === "__script_describe") return runDescribe(args)
      if (name === "__script_tool") return runTool(args, signal)
      if (name === "__script_agent") return runAgent(agentCount++, args, signal)
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

  function runTool(
    request: Readonly<Record<string, Schema.Json>>,
    signal: AbortSignal
  ): Promise<Schema.Json> {
    const name = request["name"]
    const args = request["args"]
    const phase = request["phase"]
    if (typeof name !== "string" || name.length === 0) {
      return Promise.resolve(toolFailure("Tool name must not be empty"))
    }
    if (!isJsonObject(args)) {
      return Promise.resolve(toolFailure("Tool arguments must be a JSON object"))
    }
    if (toolCalls.length >= MAX_TOOL_CALLS) {
      return Promise.resolve(toolFailure(`Code Mode allows at most ${MAX_TOOL_CALLS} tool calls`))
    }
    const toolCallId = nestedCallId(name, args)
    let entry: ScriptProgressTool = {
      phase_id: typeof request["phase_id"] === "string" ? request["phase_id"] : null,
      tool_call_id: toolCallId,
      name,
      phase: typeof phase === "string" ? phase : null,
      status: "running",
      changes_state: options.changesState?.(name) ?? false,
      args: trimmedArgs(args),
      preview: null
    } satisfies ScriptProgressTool
    let recorded: NestedCallFacts = {}
    toolCalls.push(name)
    progressTools.set(toolCallId, entry)
    emitProgress()
    return inGroup(
      options.concurrencyGroup?.(name) ?? null,
      { write: entry.changes_state, signal },
      () =>
        limitTools(() =>
          options.tool({
            onResolved: (resolvedId) => {
              entry = { ...entry, tool_call_id: resolvedId }
              progressTools.set(toolCallId, entry)
              emitProgress()
            },
            onSettled: (facts) => {
              recorded = facts
            },
            toolCallId,
            name,
            args,
            ...(entry.phase === null ? {} : { phase: entry.phase }),
            signal
          })
        )
    ).then(
      (value) => {
        progressTools.set(toolCallId, {
          ...entry,
          ...recorded,
          status: "completed",
          preview: resultPreview(value)
        })
        unreported.add(entry.tool_call_id)
        emitProgress()
        return { kind: "script_tool_result", status: "succeeded", value } as const
      },
      (cause: unknown) => {
        progressTools.set(toolCallId, {
          ...entry,
          ...recorded,
          status: "failed",
          preview: cause instanceof Error ? cause.message.slice(0, PREVIEW_CHARS) : null
        })
        unreported.add(entry.tool_call_id)
        emitProgress()
        if (cause instanceof PauseRequested) {
          halted ??= cause
          halt.abort(cause)
        }
        return toolFailure(
          errorMessage(cause, "Tool call failed"),
          cause instanceof ToolExecutionError ? cause.preview : undefined
        )
      }
    )
  }

  function runAgent(
    index: number,
    args: Readonly<Record<string, Schema.Json>>,
    signal: AbortSignal
  ): Promise<Schema.Json> {
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
    if (mode !== "research" && mode !== "code") {
      return Promise.reject(new Error("agent mode must be research or code"))
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
          launches,
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
          launches,
          error: {
            code,
            message: errorMessage(cause, "Script agent failed"),
            retryable: cause instanceof ToolExecutionError && cause.retryable === true
          }
        } as const
      }
    )
  }

  if (halted !== undefined) throw halted
  const agents = [...progressAgents.values()]
  if (outcome.status === "failed") {
    let code: ScriptError["code"] = "internal"
    if (outcome.reason === "cancelled") code = "cancelled"
    else if (outcome.reason === "timed_out") code = "timed_out"
    return {
      status: "failed",
      error: { code, message: outcome.error, retryable: outcome.reason !== "cancelled" },
      calls: toolCalls,
      logs: [],
      phases: [...progressPhases],
      agents
    }
  }
  if (!isScriptEnvelope(outcome.value)) {
    return {
      status: "failed",
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
  if (outcome.value.status === "failed") {
    const { line, ...error } = outcome.value.error
    return {
      status: "failed",
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
    status: "completed",
    phase_entries: [...phaseEntries.values()],
    value: outcome.value.value,
    calls: toolCalls,
    tools: [...progressTools.values()],
    logs: outcome.value.logs,
    phases: [...progressPhases]
  }
}

const MAX_NOT_UNDONE_NAMES = 12

const failureMessage = (
  message: string,
  line: number | undefined,
  tools: ReadonlyArray<Pick<ScriptProgressTool, "name" | "status" | "changes_state">>
): string => {
  const where = line === undefined ? "" : ` (script line ${line})`
  const counts = new Map<string, number>()
  for (const tool of tools) {
    if (tool.changes_state && tool.status !== "failed") {
      counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
    }
  }
  if (counts.size === 0) return `${message}${where}`
  const shown = [...counts].slice(0, MAX_NOT_UNDONE_NAMES)
  const names = shown.map(([name, count]) => (count > 1 ? `${name} x${count}` : name)).join(", ")
  const more = counts.size > shown.length ? `, and ${counts.size - shown.length} more` : ""
  return `${message}${where}. Already done before the failure and not undone: ${names}${more}.`
}

const toolFailure = (message: string, preview?: string) =>
  ({
    kind: "script_tool_result",
    status: "failed",
    message,
    ...(preview === undefined ? {} : { preview })
  }) as const

const optionalBoundedText = (
  value: Schema.Json | undefined,
  label: string,
  maxLength: number
): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`)
  const normalized = value.trim()
  if (normalized.length === 0) throw new TypeError(`${label} must not be empty`)
  if (normalized.length > maxLength) {
    throw new TypeError(`${label} must be at most ${maxLength} characters`)
  }
  return normalized
}
