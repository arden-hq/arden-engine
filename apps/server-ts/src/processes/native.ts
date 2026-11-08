import { Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { parseProcessTable, type ProcessCounter } from "./sampling.js"

const WindowsCounters = Schema.Array(
  Schema.Struct({
    pid: Schema.Number,
    parentPid: Schema.Number,
    started: Schema.String,
    cpuMillis: Schema.Number,
    memoryBytes: Schema.Number,
    name: Schema.String
  })
)
const WINDOWS_SCRIPT =
  "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { @{ pid=[double]$_.ProcessId; parentPid=[double]$_.ParentProcessId; started=$_.CreationDate.ToUniversalTime().ToString('o'); cpuMillis=([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000; memoryBytes=[double]$_.WorkingSetSize; name=[string]$_.Name } }) | ConvertTo-Json -Compress"

export const readProcessCounters = Effect.fn("Processes.readCounters")(
  function* (): Effect.fn.Return<
    readonly ProcessCounter[],
    unknown,
    ChildProcessSpawner.ChildProcessSpawner
  > {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const command =
      process.platform === "win32"
        ? ChildProcess.make("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            WINDOWS_SCRIPT
          ])
        : ChildProcess.make("/bin/ps", ["-axo", "pid=,ppid=,lstart=,time=,rss=,comm="], {
            env: { LC_ALL: "C" },
            extendEnv: true
          })
    const collected = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(command)
        const output = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString)
        const exit = yield* handle.exitCode
        if (Number(exit) !== 0) return yield* Effect.fail(new Error("Process collection failed"))
        return { output, pid: Number(handle.pid) }
      })
    ).pipe(Effect.timeout("3 seconds"))
    const output = collected.output
    if (process.platform !== "win32") {
      const counters = parseProcessTable(output)
      if (counters.length === 0)
        return yield* Effect.fail(new Error("Process counters unavailable"))
      return counters.filter((counter) => counter.pid !== collected.pid)
    }
    const value: unknown = JSON.parse(output)
    const counters = yield* Schema.decodeUnknownEffect(WindowsCounters)(value)
    return counters.filter((counter) => counter.pid !== collected.pid)
  }
)
