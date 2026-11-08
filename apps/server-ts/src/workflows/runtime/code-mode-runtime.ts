import { formatBytes } from "@arden-hq/std/count"
import { getQuickJS, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten"
import { Predicate, Schema } from "effect"
import { errorMessage } from "@arden-hq/std/errors"
import { currentMillis } from "../../runtime/clock.js"
import { isJsonObject } from "../../persistence/json.js"

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_CALLS = 12
const DEFAULT_MAX_CONCURRENCY = 4
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const MEGABYTE = 1024 * 1024
const MEMORY_LIMIT_BYTES = 256 * MEGABYTE
const MIN_MEMORY_LIMIT_BYTES = 64 * MEGABYTE
/**
 * Every runtime in the process allocates from one WebAssembly memory (the
 * shared QuickJS module), which is capped at 2 GB and never shrinks. A runtime
 * gets the full limit while few are live and a smaller share as they pile up,
 * so concurrent scripts cannot starve each other of heap.
 */
const SHARED_HEAP_BUDGET_BYTES = 1024 * MEGABYTE
let liveRuntimes = 0
const memoryLimitBytes = (): number =>
  Math.max(
    MIN_MEMORY_LIMIT_BYTES,
    Math.min(MEMORY_LIMIT_BYTES, Math.floor(SHARED_HEAP_BUDGET_BYTES / (liveRuntimes + 1)))
  )
const MAX_RESULT_BYTES = MIN_MEMORY_LIMIT_BYTES
const STACK_LIMIT_BYTES = 1024 * 1024
const DRAIN_BUDGET_MS = 50

interface CodeModeCall {
  readonly index: number
  readonly name: string
  readonly args: Readonly<Record<string, Schema.Json>>
  readonly signal: AbortSignal
}

export type CodeModeOutcome =
  | {
      readonly status: "completed"
      readonly value: Schema.Json
      readonly calls: ReadonlyArray<string>
    }
  | {
      readonly status: "failed"
      readonly error: string
      readonly reason: "cancelled" | "timed_out" | "runtime"
      readonly calls: ReadonlyArray<string>
    }

export interface CodeModeOptions {
  readonly code: string
  readonly signal: AbortSignal
  readonly call: (request: CodeModeCall) => Promise<Schema.Json>
  readonly timeoutMs?: number
  readonly maxCalls?: number
  readonly maxConcurrency?: number
  readonly maxOutputBytes?: number
  readonly runtimeName?: string
}

interface GuestEnvelope {
  readonly ok: boolean
  readonly value?: Schema.Json
  readonly error?: { readonly message?: string }
}

interface HostEnvelope {
  readonly ok: boolean
  readonly result?: Schema.Json
  readonly error?: { readonly message: string }
}

type ResultHandles =
  | { readonly value: QuickJSHandle; readonly error: undefined }
  | { readonly value?: undefined; readonly error: QuickJSHandle }

class Semaphore {
  readonly #limit: number
  #active = 0
  readonly #waiting: Array<() => void> = []

  constructor(limit: number) {
    this.#limit = limit
  }

  async use<A>(effect: () => Promise<A>): Promise<A> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve))
    }
    this.#active += 1
    try {
      return await effect()
    } finally {
      this.#active -= 1
      this.#waiting.shift()?.()
    }
  }
}

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8")

const safeJson = (value: unknown): string => {
  const json = JSON.stringify(value)
  if (json === undefined) throw new Error("Code Mode values must be JSON-serializable")
  return json
}

/**
 * A guest error crosses `context.dump` as a plain `{ name, message, stack }`
 * object, not an Error; read its fields (a host call may reject with a plain
 * object too). A script with a syntax error (an
 * unescaped quote in a long string) once reached the model as "[object Object]".
 */
const guestErrorMessage = (dumped: unknown): string => {
  if (Predicate.hasProperty(dumped, "message") && Predicate.isString(dumped.message)) {
    return Predicate.hasProperty(dumped, "name") && Predicate.isString(dumped.name)
      ? `${dumped.name}: ${dumped.message}`
      : dumped.message
  }
  return JSON.stringify(dumped) ?? String(dumped)
}

/**
 * QuickJS reports an exhausted heap as the bare text "out of memory" (with the
 * error name in front when a script prints it). A tool's own message that
 * merely mentions memory is left alone.
 */
export const readableRuntimeError = (message: string): string =>
  /^(?:InternalError: )?(?:out of memory|string too long)$/i.test(message.trim())
    ? "Result too large: the script ran out of memory. Fetch or read less data, narrow it before parsing, or process it in pieces."
    : message

const GuestEnvelopeSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.optionalKey(Schema.Json) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) }))
  })
])
const isGuestEnvelope = Schema.is(GuestEnvelopeSchema)

const interruptedMessage = (
  interrupted: "aborted" | "timed_out" | undefined,
  fallback: string,
  timeoutMs: number
): string => {
  if (interrupted === "aborted") return "Code Mode was cancelled"
  if (interrupted === "timed_out") return `Code Mode timed out after ${timeoutMs}ms`
  return fallback
}

const terminalInterrupt = (
  signal: AbortSignal,
  deadline: number,
  interrupted: "aborted" | "timed_out" | undefined
): "aborted" | "timed_out" | undefined => {
  if (signal.aborted) return "aborted"
  if (currentMillis() >= deadline) return "timed_out"
  return interrupted
}

const guestProgram = (code: string): string => `
      (async () => {
        try {
          const value = await (async () => { "use strict"; ${code}\n })();
          if (JSON.stringify(value) === undefined) {
            throw new TypeError("Code Mode result must be JSON-serializable");
          }
          return JSON.stringify({ ok: true, value });
        } catch (error) {
          return JSON.stringify({
            ok: false,
            error: {
              message: error && typeof error.message === "string"
                ? error.message
                : (typeof error === "object" && error !== null ? JSON.stringify(error) : String(error))
            }
          });
        }
      })()
    `

export const CODE_MODE_FRAME_LINES =
  guestProgram("\u0001").split("\u0001")[0]?.match(/\n/g)?.length ?? 0

export async function executeCodeMode(options: CodeModeOptions): Promise<CodeModeOutcome> {
  const runtimeName = options.runtimeName ?? "Code Mode"
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const deadline = currentMillis() + timeoutMs
  const calls: string[] = []
  const semaphore = new Semaphore(maxConcurrency)
  let totalOutputBytes = 0
  let callIndex = 0
  let finished = false
  const failed = (
    error: string,
    reason: "cancelled" | "timed_out" | "runtime" = "runtime"
  ): CodeModeOutcome => ({ status: "failed", error: readableRuntimeError(error), reason, calls })

  const hostCall = async (name: string, argsJson: string): Promise<string> => {
    const index = callIndex
    callIndex += 1
    if (index >= maxCalls) {
      return safeJson({
        ok: false,
        error: {
          message:
            runtimeName === "Code Mode"
              ? `Code Mode allows at most ${maxCalls} tool calls`
              : `${runtimeName} allows at most ${maxCalls} calls`
        }
      } satisfies HostEnvelope)
    }
    let args: unknown
    try {
      args = JSON.parse(argsJson)
    } catch {
      return safeJson({
        ok: false,
        error: { message: "Tool arguments must be valid JSON" }
      } satisfies HostEnvelope)
    }
    if (!isJsonObject(args)) {
      return safeJson({
        ok: false,
        error: { message: "Tool arguments must be a JSON object" }
      } satisfies HostEnvelope)
    }
    calls.push(name)
    try {
      const result = await semaphore.use(() =>
        options.call({
          index,
          name,
          args,
          signal: options.signal
        })
      )
      const json = safeJson({ ok: true, result } satisfies HostEnvelope)
      const jsonBytes = byteLength(json)
      if (jsonBytes > MAX_RESULT_BYTES) {
        throw new Error(
          `Result too large: a tool returned ${formatBytes(jsonBytes)}, more than the ${formatBytes(MAX_RESULT_BYTES)} a script can hold. Ask for less data.`
        )
      }
      totalOutputBytes += jsonBytes
      if (totalOutputBytes > maxOutputBytes) {
        throw new Error(`${runtimeName} output exceeded ${maxOutputBytes} bytes`)
      }
      return json
    } catch (cause) {
      return safeJson({
        ok: false,
        error: { message: errorMessage(cause, guestErrorMessage(cause)) }
      } satisfies HostEnvelope)
    }
  }

  const quickJs = await getQuickJS()
  const runtime = quickJs.newRuntime()
  runtime.setMemoryLimit(memoryLimitBytes())
  runtime.setMaxStackSize(STACK_LIMIT_BYTES)
  const context = runtime.newContext()
  const deferreds = new Set<QuickJSDeferredPromise>()
  let abandoned: ResultHandles | undefined

  const pumpJobs = (): void => {
    if (finished) return
    runtime.executePendingJobs().error?.dispose()
  }
  const drainJobs = (): void => {
    const drainDeadline = currentMillis() + DRAIN_BUDGET_MS
    runtime.setInterruptHandler(() => currentMillis() >= drainDeadline)
    while (currentMillis() < drainDeadline) {
      const jobs = runtime.executePendingJobs()
      jobs.error?.dispose()
      if (jobs.error === undefined && jobs.value === 0) break
    }
    runtime.removeInterruptHandler()
  }
  const cleanup = (): void => {
    if (finished) return
    finished = true
    for (const deferred of deferreds) deferred.dispose()
    abandoned?.value?.dispose()
    abandoned?.error?.dispose()
    drainJobs()
    context.dispose()
    runtime.dispose()
    liveRuntimes -= 1
  }

  let interrupted: "aborted" | "timed_out" | undefined
  runtime.setInterruptHandler(() => {
    if (options.signal.aborted) {
      interrupted = "aborted"
      return true
    }
    if (currentMillis() >= deadline) {
      interrupted = "timed_out"
      return true
    }
    return false
  })

  let timer: NodeJS.Timeout | undefined
  let abortListener: (() => void) | undefined
  liveRuntimes += 1
  try {
    const rpc = context.newFunction("__ardenCall", (nameHandle, argsHandle) => {
      const deferred = context.newPromise()
      deferreds.add(deferred)
      void hostCall(context.getString(nameHandle), context.getString(argsHandle)).then((json) => {
        if (finished) return
        // A string the heap cannot hold must not throw out of here: the
        const settle = (text: string): void => {
          const handle = context.newString(text)
          try {
            deferred.resolve(handle)
          } finally {
            handle.dispose()
          }
        }
        try {
          settle(json)
        } catch {
          try {
            settle(
              safeJson({ ok: false, error: { message: "out of memory" } } satisfies HostEnvelope)
            )
          } catch {
            // Not even the short answer fits: the script's own timeout ends it.
          }
        }
        deferreds.delete(deferred)
        deferred.dispose()
      })
      void deferred.settled.then(pumpJobs)
      return deferred.handle
    })
    context.setProp(context.global, "__ardenCall", rpc)
    rpc.dispose()

    const bootstrap = context.evalCode(`
      (() => {
        const call = globalThis.__ardenCall;
        delete globalThis.__ardenCall;
        const rpc = async (name, args = {}) => {
          let encoded;
          try { encoded = JSON.stringify(args); }
          catch { throw new TypeError("Tool arguments must be JSON-serializable"); }
          if (encoded === undefined) {
            throw new TypeError("Tool arguments must be JSON-serializable");
          }
          const response = JSON.parse(await call(String(name), encoded));
          if (response.ok) return response.result;
          throw new Error(response.error?.message || "Tool call failed");
        };
        globalThis.tools = Object.freeze({ call: rpc });
        // A deterministic, offline URL: parse, resolve, read parts, searchParams.
        const form = (text) => encodeURIComponent(text).replace(/%20/g, "+").replace(/[!'()~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
        class URLSearchParams {
          #pairs = [];
          constructor(init = "") {
            if (typeof init === "object" && init !== null) {
              const entries = typeof init[Symbol.iterator] === "function" ? [...init] : Object.entries(init);
              this.#pairs = entries.map(([k, v]) => [String(k), String(v)]);
              return;
            }
            const decode = (s) => { try { return decodeURIComponent(s.replace(/\\+/g, " ")); } catch { return s; } };
            for (const part of String(init).replace(/^\\?/, "").split("&")) {
              if (part === "") continue;
              const at = part.indexOf("=");
              this.#pairs.push(at === -1 ? [decode(part), ""] : [decode(part.slice(0, at)), decode(part.slice(at + 1))]);
            }
          }
          get size() { return this.#pairs.length; }
          get(name) { const hit = this.#pairs.find(([k]) => k === name); return hit ? hit[1] : null; }
          getAll(name) { return this.#pairs.filter(([k]) => k === name).map(([, v]) => v); }
          has(name) { return this.#pairs.some(([k]) => k === name); }
          append(name, value) { this.#pairs.push([String(name), String(value)]); }
          set(name, value) {
            const at = this.#pairs.findIndex(([k]) => k === name);
            if (at === -1) { this.append(name, value); return; }
            this.#pairs[at][1] = String(value);
            this.#pairs = this.#pairs.filter(([k], i) => k !== name || i === at);
          }
          delete(name) { this.#pairs = this.#pairs.filter(([k]) => k !== name); }
          keys() { return this.#pairs.map(([k]) => k)[Symbol.iterator](); }
          values() { return this.#pairs.map(([, v]) => v)[Symbol.iterator](); }
          entries() { return this.#pairs.map(([k, v]) => [k, v])[Symbol.iterator](); }
          [Symbol.iterator]() { return this.entries(); }
          forEach(fn) { for (const [k, v] of this.#pairs) fn(v, k, this); }
          toString() { return this.#pairs.map(([k, v]) => form(k) + "=" + form(v)).join("&"); }
        }
        const squashDots = (path) => {
          const segments = path.split("/").slice(1);
          const kept = [];
          segments.forEach((segment, i) => {
            if (segment !== "." && segment !== "..") { kept.push(segment); return; }
            if (segment === "..") kept.pop();
            if (i === segments.length - 1) kept.push("");
          });
          return "/" + kept.join("/");
        };
        class URL {
          #raw = "";
          #baseline = "";
          #authority = false;
          constructor(input, base) {
            const text = String(input).trim();
            const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\\/\\/(?:([^\\/?#@]*)@)?(\\[[^\\]]*\\]|[^\\/?#:]*)(?::(\\d*))?)?([^?#]*)(\\?[^#]*)?(#.*)?$/.exec(text);
            if (match === null || (match[3] === undefined && /^https?$/i.test(match[1]))) {
              if (base === undefined) throw new TypeError("Invalid URL: " + text.slice(0, 200));
              const root = new URL(base);
              const head = root.protocol + "//" + root.host;
              const here = head + root.pathname;
              if (text.startsWith("//")) return new URL(root.protocol + text);
              if (text.startsWith("/")) return new URL(head + text);
              if (text.startsWith("?")) return new URL(here + text);
              if (text === "" || text.startsWith("#")) return new URL(here + root.search + text);
              return new URL(here.replace(/[^\\/]*$/, "") + text);
            }
            const [, scheme, userinfo, host, port, path, query, hash] = match;
            this.protocol = scheme.toLowerCase() + ":";
            this.username = userinfo ? userinfo.split(":")[0] : "";
            this.password = userinfo && userinfo.includes(":") ? userinfo.slice(userinfo.indexOf(":") + 1) : "";
            this.hostname = (host || "").toLowerCase();
            this.port = port === { "http:": "80", "https:": "443" }[this.protocol] ? "" : port || "";
            const route = (path || (host === undefined ? "" : "/")).replace(/ /g, "%20");
            this.pathname = /^https?:$/.test(this.protocol) ? squashDots(route) : route;
            this.hash = hash && hash !== "#" ? hash : "";
            this.#authority = host !== undefined;
            this.#raw = query && query !== "?" ? query : "";
            this.searchParams = new URLSearchParams(this.#raw);
            this.#baseline = this.searchParams.toString();
          }
          // Untouched, the query keeps its original spelling; edited, it is rewritten.
          get search() {
            const now = this.searchParams.toString();
            return now === this.#baseline ? this.#raw : now ? "?" + now : "";
          }
          get host() { return this.port ? this.hostname + ":" + this.port : this.hostname; }
          get origin() { return /^https?:$/.test(this.protocol) ? this.protocol + "//" + this.host : "null"; }
          get href() {
            const auth = this.username ? this.username + (this.password ? ":" + this.password : "") + "@" : "";
            return this.protocol + (this.#authority ? "//" + auth + this.host : "") + this.pathname + this.search + this.hash;
          }
          toString() { return this.href; }
          toJSON() { return this.href; }
        }
        globalThis.URL = URL;
        globalThis.URLSearchParams = URLSearchParams;
        globalThis.console = undefined;
        globalThis.Date = undefined;
        Math.random = undefined;
      })()
    `)
    if (bootstrap.error !== undefined) {
      const message = guestErrorMessage(context.dump(bootstrap.error))
      bootstrap.error.dispose()
      return failed(message)
    }
    bootstrap.value.dispose()

    const evaluated = context.evalCode(guestProgram(options.code))
    if (evaluated.error !== undefined) {
      const message = interruptedMessage(
        interrupted,
        guestErrorMessage(context.dump(evaluated.error)),
        timeoutMs
      )
      evaluated.error.dispose()
      return failed(message, interrupted === "aborted" ? "cancelled" : (interrupted ?? "runtime"))
    }

    const guestPromise = context.resolvePromise(evaluated.value)
    evaluated.value.dispose()
    void guestPromise.then((result) => {
      if (!finished) abandoned = result
    })
    pumpJobs()

    const timeout = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), Math.max(0, deadline - currentMillis()))
    })
    const aborted = new Promise<"aborted">((resolve) => {
      if (options.signal.aborted) {
        resolve("aborted")
        return
      }
      abortListener = () => resolve("aborted")
      options.signal.addEventListener("abort", abortListener, { once: true })
    })
    const outcome = await Promise.race([
      guestPromise.then((result) => ({ status: "settled" as const, result })),
      timeout.then((status) => ({ status, result: undefined })),
      aborted.then((status) => ({ status, result: undefined }))
    ])
    if (outcome.status !== "settled") {
      return failed(
        interruptedMessage(outcome.status, "Code Mode failed", timeoutMs),
        outcome.status === "aborted" ? "cancelled" : "timed_out"
      )
    }

    abandoned = undefined
    if (outcome.result.error !== undefined) {
      const message = guestErrorMessage(context.dump(outcome.result.error))
      outcome.result.error.dispose()
      return failed(
        interruptedMessage(interrupted, message, timeoutMs),
        interrupted === "aborted" ? "cancelled" : (interrupted ?? "runtime")
      )
    }
    const decoded: unknown = JSON.parse(context.getString(outcome.result.value))
    outcome.result.value.dispose()
    if (!isGuestEnvelope(decoded)) {
      return failed("Code Mode returned an invalid result")
    }
    const envelope: GuestEnvelope = decoded
    if (!envelope.ok) {
      const terminal = terminalInterrupt(options.signal, deadline, interrupted)
      return failed(
        interruptedMessage(terminal, envelope.error?.message ?? "Code Mode failed", timeoutMs),
        terminal === "aborted" ? "cancelled" : (terminal ?? "runtime")
      )
    }
    const resultJson = safeJson(envelope.value ?? null)
    if (byteLength(resultJson) > maxOutputBytes) {
      return failed(`Code Mode result exceeded ${maxOutputBytes} bytes`)
    }
    return { status: "completed", value: envelope.value ?? null, calls }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abortListener !== undefined) options.signal.removeEventListener("abort", abortListener)
    runtime.removeInterruptHandler()
    cleanup()
  }
}
