import { MAX_BRANCH_NAME, MAX_PARALLEL_ITEMS } from "./script-run.js"

export const buildScript = (
  userCode: string,
  lineBase: number,
  maxAgents: number,
  argsJson: string
): string => `
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
        mode: options.mode === "code" || options.mode === "work" ? options.mode : "research",
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
