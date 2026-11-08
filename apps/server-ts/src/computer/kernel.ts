import { formatBytes } from "@arden-hq/std/count"
import { getQuickJS, type QuickJSContext, type QuickJSDeferredPromise } from "quickjs-emscripten"
import { Schema } from "effect"
import { errorMessage } from "@arden-hq/std/errors"
import { currentMillis } from "../runtime/clock.js"

const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json))
const isJson = Schema.is(Schema.Json)
const MAX_BYTES = 1024 * 1024
const MAX_ARGUMENT_BYTES = 64 * 1024

export interface ComputerCell {
  readonly code: string
  readonly signal: AbortSignal
  readonly call: (
    name: string,
    args: Readonly<Record<string, Schema.Json>>,
    index: number,
    signal: AbortSignal
  ) => Promise<Schema.Json>
  readonly timeoutMs?: number
}

interface ActiveCell {
  readonly input: ComputerCell
  readonly controller: AbortController
  readonly deadline: number
  readonly pending: Set<Promise<void>>
  calls: number
  bytes: number
}

export class ComputerKernel {
  #active: ActiveCell | undefined
  #closed = false
  #cpuDeadline = 0
  readonly #deferreds = new Set<QuickJSDeferredPromise>()

  private constructor(readonly context: QuickJSContext) {}

  static async create(): Promise<ComputerKernel> {
    const quickJs = await getQuickJS()
    const runtime = quickJs.newRuntime()
    runtime.setMemoryLimit(64 * 1024 * 1024)
    runtime.setMaxStackSize(1024 * 1024)
    const kernel = new ComputerKernel(runtime.newContext())
    runtime.setInterruptHandler(
      () =>
        kernel.#closed ||
        kernel.#active === undefined ||
        kernel.#active.controller.signal.aborted ||
        currentMillis() >= Math.min(kernel.#active.deadline, kernel.#cpuDeadline)
    )
    const rpc = kernel.context.newFunction("__call", (name, args) => {
      const active = kernel.#active
      if (active === undefined) throw new Error("No active computer cell")
      const deferred = kernel.context.newPromise()
      kernel.#deferreds.add(deferred)
      const operation = kernel.#call(
        active,
        kernel.context.getString(name),
        kernel.context.getString(args)
      ).then((json) => {
        if (kernel.#closed || kernel.#active !== active) return
        const value = kernel.context.newString(json)
        deferred.resolve(value)
        value.dispose()
        kernel.#deferreds.delete(deferred)
        deferred.dispose()
        kernel.#cpuDeadline = currentMillis() + 100
        const jobs = runtime.executePendingJobs()
        if (jobs.error !== undefined) {
          jobs.error.dispose()
          active.controller.abort(new Error("Computer script exceeded its CPU budget"))
        }
      })
      active.pending.add(operation)
      void operation.finally(() => active.pending.delete(operation))
      return deferred.handle
    })
    kernel.context.setProp(kernel.context.global, "__call", rpc)
    rpc.dispose()
    runtime.removeInterruptHandler()
    const bootstrap = kernel.context.evalCode(COMPUTER_BOOTSTRAP)
    if (bootstrap.error !== undefined) {
      bootstrap.error.dispose()
      kernel.close()
      throw new Error("Computer runtime initialization failed")
    }
    bootstrap.value.dispose()
    runtime.setInterruptHandler(
      () =>
        kernel.#closed ||
        kernel.#active === undefined ||
        kernel.#active.controller.signal.aborted ||
        currentMillis() >= Math.min(kernel.#active.deadline, kernel.#cpuDeadline)
    )
    return kernel
  }

  get closed(): boolean {
    return this.#closed
  }

  async execute(input: ComputerCell): Promise<Schema.Json> {
    if (this.#closed) throw new Error("Computer session reset; create a new session")
    if (this.#active !== undefined) throw new Error("A computer cell is already running")
    input.signal.throwIfAborted()
    const controller = new AbortController()
    const timeoutMs = input.timeoutMs ?? 30_000
    const active: ActiveCell = {
      input,
      controller,
      deadline: currentMillis() + timeoutMs,
      pending: new Set(),
      calls: 0,
      bytes: 0
    }
    this.#active = active
    const abort = (): void => controller.abort(input.signal.reason)
    input.signal.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(
      () => controller.abort(new Error("Computer cell timed out; observe before acting again")),
      timeoutMs
    )
    let onAbort: (() => void) | undefined
    try {
      this.#cpuDeadline = currentMillis() + 100
      const result = this.context.evalCode(
        `(async () => { "use strict"; ${input.code}\n })().then(value => JSON.stringify(value === undefined ? null : value))`
      )
      if (result.error !== undefined) {
        const message = JSON.stringify(this.context.dump(result.error))
        result.error.dispose()
        throw new Error(message)
      }
      const pending = this.context.resolvePromise(result.value)
      result.value.dispose()
      this.context.runtime.executePendingJobs().error?.dispose()
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(new Error("Computer cell stopped; its last action may have completed"))
        if (controller.signal.aborted) onAbort()
        else controller.signal.addEventListener("abort", onAbort, { once: true })
      })
      const resolved = await Promise.race([pending, interrupted])
      if (resolved.error !== undefined) {
        const message = JSON.stringify(this.context.dump(resolved.error))
        resolved.error.dispose()
        throw new Error(message)
      }
      const json = this.context.getString(resolved.value)
      resolved.value.dispose()
      if (active.pending.size !== 0)
        throw new Error("Await every computer operation; unfinished operations reset the session")
      if (Buffer.byteLength(json) > MAX_BYTES)
        throw new Error(`Computer result exceeds ${formatBytes(MAX_BYTES)}`)
      const value: unknown = JSON.parse(json)
      if (!isJson(value)) throw new Error("Computer result is not JSON")
      return value
    } catch (cause) {
      if (
        this.#closed ||
        controller.signal.aborted ||
        currentMillis() >= Math.min(active.deadline, this.#cpuDeadline) ||
        active.pending.size !== 0 ||
        this.context.runtime.hasPendingJob()
      ) {
        controller.abort(cause)
        this.close()
      }
      throw cause
    } finally {
      clearTimeout(timer)
      input.signal.removeEventListener("abort", abort)
      if (onAbort !== undefined) controller.signal.removeEventListener("abort", onAbort)
      this.#active = undefined
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#active?.controller.abort(new Error("Computer session reset"))
    for (const deferred of this.#deferreds) deferred.dispose()
    this.#deferreds.clear()
    this.context.dispose()
    this.context.runtime.dispose()
  }

  async #call(active: ActiveCell, name: string, encoded: string): Promise<string> {
    try {
      active.controller.signal.throwIfAborted()
      if (++active.calls > 32) throw new Error("Computer cells allow at most 32 operations")
      if (Buffer.byteLength(encoded) > MAX_ARGUMENT_BYTES)
        throw new Error(`Computer arguments exceed ${formatBytes(MAX_ARGUMENT_BYTES)}`)
      const args: unknown = JSON.parse(encoded)
      if (!isJsonObject(args)) throw new Error("Computer arguments must be a JSON object")
      const result = await active.input.call(name, args, active.calls, active.controller.signal)
      active.controller.signal.throwIfAborted()
      const value =
        name.startsWith("computer_") && isJsonObject(result) && "data" in result
          ? {
              data: isJsonObject(result.data)
                ? Object.fromEntries(
                    Object.entries(result.data).filter(([key]) => key !== "computer")
                  )
                : result.data
            }
          : result
      const json = JSON.stringify({ ok: true, value })
      active.bytes += Buffer.byteLength(json)
      if (active.bytes > MAX_BYTES)
        throw new Error(`Computer observations exceed ${formatBytes(MAX_BYTES)}; narrow the query`)
      return json
    } catch (cause) {
      return JSON.stringify({ ok: false, error: errorMessage(cause) })
    }
  }
}

const COMPUTER_BOOTSTRAP = `(() => {
  const host = globalThis.__call;
  delete globalThis.__call;
  const call = async (name, args = {}) => {
    const result = JSON.parse(await host(name, JSON.stringify(args)));
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  globalThis.state = Object.create(null);
  const native = async (name, args) => (await call(name, args)).data;
  const windowHandle = (target) => {
    let latest;
    let readOptions = {};
    let busy = false;
    const observe = async (options = readOptions) => {
      latest = undefined;
      readOptions = options;
      const result = await native("computer_read", {...options, operation:"state", target});
      latest = result;
      return result.state;
    };
    const exclusive = async (operation) => {
      if (busy) throw new Error("Await the previous operation on this window");
      busy = true;
      try { return await operation(); } finally { busy = false; }
    };
    return Object.freeze({
      target,
      observe: (options = {}) => exclusive(() => observe(options)),
      act: (options) => exclusive(async () => {
        if (!latest?.observation) throw new Error("Observe this window before acting");
        const previous = latest;
        latest = undefined;
        const result = await native("computer_act", {
          ...options, target, observation: previous.observation,
          ...((options.action === "pixel_click" || options.action === "drag") && options.capture === undefined && readOptions.screenshot
            ? {capture: previous.state.capture_id} : {})
        });
        try {
          return {...await observe(), action_result: result.state};
        } catch (error) {
          return {action_result: result.state, observation_error: String(error)};
        }
      })
    });
  };
  const browser = async (name, args) => {
    const result = await call(name, args);
    return result.data ?? {content: result.content};
  };
  const tabHandle = (tab_ref) => {
    let latest;
    let readOptions = {};
    let busy = false;
    const exclusive = async (operation) => {
      if (busy) throw new Error("Await the previous operation on this tab");
      busy = true;
      try { return await operation(); } finally { busy = false; }
    };
    const observe = async (options = readOptions) => {
      latest = undefined;
      readOptions = {...options};
      const result = await browser("browser_snapshot", {...options, tab_ref});
      if ((options.mode ?? "interactive") === "interactive") latest = result;
      return result;
    };
    return Object.freeze({
      observe: (options = {}) => exclusive(() => observe(options)),
      act: (options) => exclusive(async () => {
        if (!latest) throw new Error("Observe this tab in interactive mode before acting");
        const {observe: read = readOptions, ...action} = options;
        const previous = latest;
        latest = undefined;
        readOptions = {...read};
        const interactive = (read.mode ?? "interactive") === "interactive" && read.grep === undefined;
        const {page, ...result} = await browser("browser_act", {
          ...action, tab_ref, profile_ref: previous.tab.profile_ref, origin: previous.origin,
          snapshot_ref: previous.snapshot_ref,
          snapshot: interactive
            ? {scope: read.scope, depth: read.depth, max_chars: read.max_chars}
            : "none"
        });
        // browser_act returns the next interactive snapshot; a text or grep read is a second call.
        if (page !== undefined) {
          latest = page;
          return {...page, action_result: result};
        }
        try {
          return {...await observe(read), action_result: result};
        } catch (error) {
          return {action_result: result, observation_error: String(error)};
        }
      }),
      // Keep screenshot prose: it includes image scaling and artifact display instructions.
      screenshot: () => exclusive(() => call("browser_screenshot", {tab_ref})),
      pointer: (options) => exclusive(async () => {
        latest = undefined;
        return await browser("browser_pointer", {...options, tab_ref});
      }),
      wait: (options) => exclusive(async () => {
        latest = undefined;
        return await browser("browser_wait", {...options, tab_ref});
      })
    });
  };
  globalThis.cua = Object.freeze({
    apps: async () => (await native("computer_read", {operation:"apps"})).state,
    launch: async (options) => (await native("computer_launch", options)).state,
    clipboard: Object.freeze({writeText: async (text) => (await native("computer_clipboard_write", {text})).state}),
    windows: async (pid) => (await native("computer_read", {operation:"windows", pid})).state,
    window: (target) => windowHandle(Object.freeze({pid:target.pid, window_id:target.window_id})),
    tabs: () => browser("browser_tabs"),
    tab: (tab_ref) => tabHandle(tab_ref)
  });
  globalThis.console = undefined;
  globalThis.Date = undefined;
  Math.random = undefined;
})()`
