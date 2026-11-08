import { makeToolOutputStream, type ToolOutputFrame } from "./output-stream.js"
import { BoundedCapture } from "./bash-capture.js"
import {
  sandboxDenialNote,
  sandboxUnavailable,
  shellInvocation,
  shellRuntime,
  type ShellInvocation
} from "./shell-policy.js"
import { BUBBLEWRAP_PATH, bubblewrapFailure } from "../runtime/command-sandbox.js"
import type { ShellRuntimeOptions } from "./shell-policy.js"
import type { LocalPathPolicy } from "../storage/local-paths.js"
import { spawnLiveProcess, type LiveProcess, type ProcessInput } from "../terminals/live-process.js"
import { toolFault, toolRefusal } from "./tool-failure.js"

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
export const MAX_CAPTURE_BYTES = 1024 * 1024

export class CommandInterrupted extends Error {
  constructor(
    message: string,
    readonly output: Buffer,
    readonly outputTruncated: boolean
  ) {
    super(message)
  }
}

export interface CommandExited {
  readonly state: "exited"
  readonly output: string
  readonly exitCode: number
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly fullOutput?: Buffer
  readonly fullOutputTruncated: boolean
}

export interface CommandRunning {
  readonly state: "running"
  readonly output: string
}

interface CommandOptions extends ShellRuntimeOptions {
  readonly onOutput?: (frame: ToolOutputFrame) => Promise<void>
  readonly captureFullOutput?: boolean
  readonly input?: ProcessInput
  readonly spawn?: (invocation: ShellInvocation, input: ProcessInput) => LiveProcess
}

export const runCommandUntil = (
  command: string,
  cwd: string,
  signal: AbortSignal,
  policy: LocalPathPolicy,
  options: CommandOptions & { readonly yieldMs: number }
): Promise<CommandExited | CommandRunning> =>
  new Promise((resolve, reject) => {
    const stdout = new BoundedCapture(MAX_CAPTURE_BYTES)
    const stderr = new BoundedCapture(MAX_CAPTURE_BYTES)
    const full = new BoundedCapture(MAX_ARTIFACT_BYTES)
    const live =
      options.onOutput === undefined
        ? undefined
        : makeToolOutputStream(options.onOutput, MAX_CAPTURE_BYTES)
    if (signal.aborted) {
      reject(toolRefusal("The command was cancelled before it started.", "Command cancelled"))
      return
    }
    let invocation: ShellInvocation
    try {
      invocation = shellInvocation(command, cwd, policy, shellRuntime(options))
    } catch (cause) {
      reject(cause)
      return
    }
    const input = options.input ?? "closed"
    const child = (options.spawn ?? ((spec, mode) => spawnLiveProcess(spec, { input: mode })))(
      invocation,
      input
    )
    let settled = false

    const finish = (effect: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      stopData()
      stopExit()
      stopError()
      if (live === undefined) effect()
      else void live.close().then(effect)
    }
    const uncertain = (message: string): void => {
      child.kill()
      finish(() =>
        reject(new CommandInterrupted(message, full.bytes(), full.totalBytes > MAX_ARTIFACT_BYTES))
      )
    }
    const onAbort = (): void =>
      uncertain("The command was cancelled after it started; its side effects may have landed.")
    const timer = setTimeout(
      () => finish(() => resolve({ state: "running", output: formatOutput(stdout, stderr) })),
      options.yieldMs
    )

    signal.addEventListener("abort", onAbort, { once: true })
    const stopData = child.onData((stream, chunk) => {
      ;(stream === "stdout" ? stdout : stderr).append(chunk)
      if (options.captureFullOutput) full.append(chunk)
      live?.write(stream, chunk)
    })
    const sandboxed = invocation.executable === BUBBLEWRAP_PATH
    const stopError = child.onSpawnError(() =>
      finish(() =>
        reject(
          sandboxed
            ? sandboxUnavailable("missing")
            : toolFault("The shell command could not be started.", "Command failed")
        )
      )
    )
    const stopExit = child.onExit((exit) =>
      finish(() => {
        if (exit.kind === "signal") {
          reject(new Error(`The shell stopped unexpectedly (${exit.signal}).`))
          return
        }
        const sandboxFailure =
          sandboxed && exit.code !== 0 ? bubblewrapFailure(stderr.text()) : undefined
        if (sandboxFailure !== undefined) {
          reject(sandboxUnavailable(sandboxFailure))
          return
        }
        const denial = sandboxDenialNote(policy, stderr.text())
        const output = [
          formatOutput(stdout, stderr),
          ...(exit.code === 0 ? [] : [`[exit code: ${exit.code}]`]),
          ...(denial === undefined ? [] : [denial])
        ]
          .filter((part) => part.length > 0)
          .join("\n")
        if (exit.code !== 0 && !options.captureFullOutput) {
          reject(toolRefusal(output || "(no output)", `Exit ${exit.code}`))
          return
        }
        resolve({
          state: "exited",
          output: output || "(no output)",
          exitCode: exit.code,
          stdoutBytes: stdout.totalBytes,
          stderrBytes: stderr.totalBytes,
          ...(options.captureFullOutput ? { fullOutput: full.bytes() } : {}),
          fullOutputTruncated: full.totalBytes > MAX_ARTIFACT_BYTES
        })
      })
    )
    if (signal.aborted) onAbort()
  })

const formatOutput = (stdout: BoundedCapture, stderr: BoundedCapture): string => {
  const stderrText = stderr.text()
  return [stdout.text(), ...(stderrText.length === 0 ? [] : [`[stderr]\n${stderrText}`])]
    .filter((part) => part.length > 0)
    .join("\n")
}
