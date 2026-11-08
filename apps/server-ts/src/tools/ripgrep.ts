import { cutText } from "@arden-hq/std/text"
import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import { constants } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SEARCH_TIMEOUT_MS = 20_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_STDERR_BYTES = 8 * 1024
const MAX_RECORD_BYTES = 64 * 1024
const EXCLUDES = ["!**/.git/**", "!**/node_modules/**", "!**/.venv/**", "!**/__pycache__/**"]

interface RipgrepRun<A> {
  readonly items: ReadonlyArray<A>
  readonly truncated: boolean
  readonly partial: boolean
  readonly outputBytes: number
}

export class RipgrepSearchError extends Error {
  readonly reason: "output_limit" | "record_limit" | "timeout"

  constructor(reason: RipgrepSearchError["reason"], message: string) {
    super(message)
    this.name = "RipgrepSearchError"
    this.reason = reason
  }
}

export interface RipgrepContentMatch {
  readonly path: string
  readonly line: number
  readonly column: number
  readonly text: string
  readonly textTruncated: boolean
}

export interface RipgrepCountMatch {
  readonly path: string
  readonly count: number
}

const require = createRequire(import.meta.url)
const binaryName = process.platform === "win32" ? "rg.exe" : "rg"
const stagedPath = fileURLToPath(new URL(`./bin/${binaryName}`, import.meta.url))

let ripgrepPath: Promise<string> | undefined

const resolveRipgrepPath = (): Promise<string> => {
  ripgrepPath ??= access(stagedPath, constants.X_OK)
    .then(() => stagedPath)
    .catch(() => {
      try {
        const dependency = require("@vscode/ripgrep") as { readonly rgPath?: unknown }
        return typeof dependency.rgPath === "string" ? dependency.rgPath : binaryName
      } catch {
        return binaryName
      }
    })
  return ripgrepPath
}

const runRipgrep = async <A>(input: {
  readonly cwd: string
  readonly args: ReadonlyArray<string>
  readonly delimiter: 0 | 10
  readonly limit: number
  readonly signal: AbortSignal
  readonly parse: (record: Buffer) => A | undefined
}): Promise<RipgrepRun<A>> => {
  const command = await resolveRipgrepPath()
  return new Promise((resolve, reject) => {
    const child = spawn(command, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    })
    const items: A[] = []
    const stderr: Buffer[] = []
    let stderrBytes = 0
    let outputBytes = 0
    let pending = Buffer.alloc(0)
    let settled = false
    let intentionallyStopped = false

    const cleanup = (): void => {
      clearTimeout(timer)
      input.signal.removeEventListener("abort", onAbort)
    }
    const fail = (cause: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(cause)
    }
    const finish = (partial: boolean): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        items,
        truncated: intentionallyStopped,
        partial,
        outputBytes
      })
    }
    const stop = (): void => {
      if (intentionallyStopped) return
      intentionallyStopped = true
      child.kill("SIGTERM")
    }
    const consume = (record: Buffer): void => {
      if (record.byteLength === 0 || items.length >= input.limit) return
      if (record.byteLength > MAX_RECORD_BYTES) {
        child.kill("SIGKILL")
        fail(
          new RipgrepSearchError(
            "record_limit",
            "A ripgrep result record exceeded the safe size limit"
          )
        )
        return
      }
      const parsed = input.parse(record)
      if (parsed === undefined) return
      items.push(parsed)
      if (items.length >= input.limit) stop()
    }
    const consumePending = (final: boolean): void => {
      while (true) {
        const separator = pending.indexOf(input.delimiter)
        if (separator < 0) break
        consume(pending.subarray(0, separator))
        pending = pending.subarray(separator + 1)
      }
      if (final && pending.byteLength > 0) consume(pending)
    }
    const onAbort = (): void => {
      child.kill("SIGKILL")
      fail(input.signal.reason ?? new DOMException("File search was cancelled", "AbortError"))
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      fail(new RipgrepSearchError("timeout", "ripgrep timed out after 20 seconds"))
    }, SEARCH_TIMEOUT_MS)

    if (input.signal.aborted) {
      onAbort()
      return
    }
    input.signal.addEventListener("abort", onAbort, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL")
        fail(new RipgrepSearchError("output_limit", "ripgrep output exceeded the safe size limit"))
        return
      }
      pending = Buffer.concat([pending, chunk])
      consumePending(false)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return
      const visible = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes)
      stderr.push(visible)
      stderrBytes += visible.byteLength
    })
    child.once("error", fail)
    child.once("close", (code) => {
      consumePending(true)
      const partial = code === 2
      if (!intentionallyStopped && code !== 0 && code !== 1 && !partial) {
        const message = Buffer.concat(stderr).toString("utf8").trim()
        fail(new Error(message || `ripgrep failed with exit code ${code ?? "unknown"}`))
        return
      }
      if (partial && items.length === 0) {
        const message = Buffer.concat(stderr).toString("utf8").trim()
        if (message.length > 0) {
          fail(new Error(message))
          return
        }
      }
      finish(partial)
    })
  })
}

const literalGlob = (relative: string): string => relative.replace(/[\\*?[\]{}!]/gu, "\\$&")

/**
 * The fixed excludes, then each folder the owner's never rule hides under the
 * search root (`skip`, relative to it): it and everything in it, any case,
 * so a search never walks into it. ripgrep follows no links.
 */
const excludeArgs = (skip: ReadonlyArray<string> = []): ReadonlyArray<string> => [
  ...EXCLUDES.flatMap((glob) => ["--glob", glob]),
  ...skip.flatMap((relative) => {
    const folder = literalGlob(relative)
    return ["--iglob", `!${folder}`, "--iglob", `!${folder}/**`]
  })
]

const matchesGlob = (candidate: string, pattern: string | undefined): boolean =>
  pattern === undefined ||
  path.matchesGlob(candidate, pattern) ||
  path.matchesGlob(path.basename(candidate), pattern)

export const ripgrepFind = (input: {
  readonly cwd: string
  readonly pattern: string
  readonly includeHidden: boolean
  readonly limit: number
  readonly signal: AbortSignal
  readonly skip: ReadonlyArray<string>
}): Promise<RipgrepRun<string>> =>
  runRipgrep({
    cwd: input.cwd,
    args: [
      "--no-config",
      "--files",
      "--null",
      "--sort",
      "path",
      ...(input.includeHidden ? ["--hidden"] : []),
      ...(input.pattern === "*" ? [] : ["--glob", input.pattern]),
      ...excludeArgs(input.skip),
      "."
    ],
    delimiter: 0,
    limit: input.limit,
    signal: input.signal,
    parse: (record) => {
      const candidate = record.toString("utf8").replace(/^\.\//u, "")
      return matchesGlob(candidate, input.pattern) ? candidate : undefined
    }
  })

const searchBaseArgs = (input: {
  readonly query: string
  readonly fileGlob?: string
  readonly target: string
  readonly includeHidden: boolean
  readonly skip: ReadonlyArray<string>
}): ReadonlyArray<string> => [
  "--no-config",
  "--fixed-strings",
  "--sort",
  "path",
  "--no-messages",
  ...(input.includeHidden ? ["--hidden"] : []),
  ...(input.fileGlob === undefined ? [] : ["--glob", input.fileGlob]),
  ...excludeArgs(input.skip),
  "--",
  input.query,
  input.target
]

export const ripgrepSearchFiles = (input: {
  readonly cwd: string
  readonly query: string
  readonly fileGlob?: string
  readonly target: string
  readonly includeHidden: boolean
  readonly skip: ReadonlyArray<string>
  readonly limit: number
  readonly signal: AbortSignal
}): Promise<RipgrepRun<string>> =>
  runRipgrep({
    cwd: input.cwd,
    args: ["--files-with-matches", "--null", ...searchBaseArgs(input)],
    delimiter: 0,
    limit: input.limit,
    signal: input.signal,
    parse: (record) => {
      const candidate = record.toString("utf8").replace(/^\.\//u, "")
      return matchesGlob(candidate, input.fileGlob) ? candidate : undefined
    }
  })

export const ripgrepSearchCounts = (input: {
  readonly cwd: string
  readonly query: string
  readonly fileGlob?: string
  readonly target: string
  readonly includeHidden: boolean
  readonly skip: ReadonlyArray<string>
  readonly limit: number
  readonly signal: AbortSignal
}): Promise<RipgrepRun<RipgrepCountMatch>> =>
  runRipgrep({
    cwd: input.cwd,
    args: ["--count-matches", "--null", ...searchBaseArgs(input)],
    delimiter: 10,
    limit: input.limit,
    signal: input.signal,
    parse: (record) => {
      const separator = record.lastIndexOf(0)
      if (separator < 0) return undefined
      const count = Number(record.subarray(separator + 1).toString("utf8"))
      if (!Number.isSafeInteger(count) || count < 1) return undefined
      const candidate = record.subarray(0, separator).toString("utf8").replace(/^\.\//u, "")
      if (!matchesGlob(candidate, input.fileGlob)) return undefined
      return {
        path: candidate,
        count
      }
    }
  })

export const ripgrepSearchContent = (input: {
  readonly cwd: string
  readonly query: string
  readonly fileGlob?: string
  readonly target: string
  readonly includeHidden: boolean
  readonly skip: ReadonlyArray<string>
  readonly limit: number
  readonly signal: AbortSignal
}): Promise<RipgrepRun<RipgrepContentMatch>> =>
  runRipgrep({
    cwd: input.cwd,
    args: ["--json", "--max-columns", "4096", "--max-columns-preview", ...searchBaseArgs(input)],
    delimiter: 10,
    limit: input.limit,
    signal: input.signal,
    parse: (record) => {
      let value: unknown
      try {
        value = JSON.parse(record.toString("utf8"))
      } catch {
        return undefined
      }
      if (
        value === null ||
        typeof value !== "object" ||
        !("type" in value) ||
        value.type !== "match"
      ) {
        return undefined
      }
      const data =
        "data" in value && value.data !== null && typeof value.data === "object"
          ? value.data
          : undefined
      if (data === undefined) return undefined
      const path =
        "path" in data &&
        data.path !== null &&
        typeof data.path === "object" &&
        "text" in data.path &&
        typeof data.path.text === "string"
          ? data.path.text
          : undefined
      const text =
        "lines" in data &&
        data.lines !== null &&
        typeof data.lines === "object" &&
        "text" in data.lines &&
        typeof data.lines.text === "string"
          ? data.lines.text.replace(/\r?\n$/u, "")
          : undefined
      const line =
        "line_number" in data && typeof data.line_number === "number" ? data.line_number : undefined
      const submatches =
        "submatches" in data && Array.isArray(data.submatches) ? data.submatches : []
      const first = submatches[0]
      const column =
        first !== null &&
        typeof first === "object" &&
        "start" in first &&
        typeof first.start === "number"
          ? first.start + 1
          : 1
      if (
        path === undefined ||
        text === undefined ||
        line === undefined ||
        !matchesGlob(path.replace(/^\.\//u, ""), input.fileGlob)
      )
        return undefined
      return {
        path: path.replace(/^\.\//u, ""),
        line,
        column,
        text: cutText(text, 4_096),
        textTruncated: text.length > 4_096
      }
    }
  })
