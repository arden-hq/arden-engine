import { processStopTarget } from "../../processes/stop-target.js"
import { cpus, hostname } from "node:os"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import type { ProcessSnapshot } from "@arden-hq/protocol/processes"
import { ArdenApi } from "../api.js"
import { TerminalSessions } from "../../terminals/service.js"
import { SessionQueries } from "../../persistence/sessions/queries.js"
import { ProcessSampler } from "../../processes/sampling.js"
import { readProcessCounters } from "../../processes/native.js"
import { currentMillis, iso } from "../../runtime/clock.js"
import { LlamaServer } from "../../local-models/llama-server.js"

export const ProcessHandlers = HttpApiBuilder.group(
  ArdenApi,
  "processes",
  Effect.fn("ProcessHandlers")(function* (handlers) {
    const terminals = yield* TerminalSessions
    const sessions = yield* SessionQueries
    const llama = yield* LlamaServer
    const sampler = new ProcessSampler()
    const cpuCount = Math.max(1, cpus().length)
    const desktopPid = Number(process.env.ARDEN_DESKTOP_PROCESS_PID)
    const rootPid = Number.isSafeInteger(desktopPid) && desktopPid > 0 ? desktopPid : process.pid
    const names = new Map<string, { readonly at: number; readonly name: string }>()
    let last: ProcessSnapshot | undefined
    const sample = Effect.fn("Processes.snapshot")(function* (): Effect.fn.Return<
      ProcessSnapshot,
      unknown,
      import("effect/unstable/process").ChildProcessSpawner.ChildProcessSpawner
    > {
      const counters = yield* readProcessCounters()
      const at = currentMillis()
      const modelPid = llama.processId()
      const processes = sampler.sample({
        counters,
        terminals: terminals.all(),
        rootPid,
        at,
        cpuCount,
        services: [
          { pid: process.pid, name: "Agent runtime", group: "Arden" },
          ...(modelPid === undefined
            ? []
            : [
                {
                  pid: modelPid,
                  name: "Local model router",
                  group: "Local models",
                  childName: "Local model worker"
                }
              ])
        ]
      })
      const ids = new Set(
        processes.flatMap((row) => (row.owner.kind === "command" ? [row.owner.session_id] : []))
      )
      for (const id of ids) {
        const previous = names.get(id)
        if (previous !== undefined && at - previous.at < 30000) continue
        const header = yield* sessions
          .loadHistoryHeader(id)
          .pipe(Effect.catch(() => Effect.succeed(null)))
        names.set(id, { at, name: header?.name ?? "Unnamed chat" })
      }
      for (const id of names.keys()) if (!ids.has(id)) names.delete(id)
      last = {
        state: "ready",
        sampled_at: iso(at),
        host: hostname(),
        cpu_count: cpuCount,
        detail: null,
        processes: processes.map((row) =>
          row.owner.kind === "command"
            ? {
                ...row,
                owner: {
                  ...row.owner,
                  name: names.get(row.owner.session_id)?.name ?? "Unnamed chat"
                }
              }
            : row
        )
      }
      return last
    })
    const snapshot = yield* Effect.cachedWithTTL(
      sample().pipe(
        Effect.catch(() =>
          Effect.succeed<ProcessSnapshot>({
            state: "unavailable",
            sampled_at: iso(currentMillis()),
            host: hostname(),
            cpu_count: cpuCount,
            processes: [],
            detail: "Process metrics could not be collected. Try again."
          })
        )
      ),
      "1 second"
    )
    return handlers
      .handle("snapshot", () => snapshot)
      .handle("output", ({ query }) =>
        Effect.sync(() => {
          const owner = last?.processes.find((row) => row.key === query.key)?.owner
          if (owner?.kind !== "command") return { state: "unavailable" as const, output: "" }
          const terminal = terminals.get(owner.terminal_id)
          if (
            terminal === undefined ||
            terminal.sessionId !== owner.session_id ||
            terminal.runId !== owner.run_id
          )
            return { state: "unavailable" as const, output: "" }
          return {
            state: terminal.exit === undefined ? ("running" as const) : ("exited" as const),
            output: terminals.replay(terminal.id)?.output.slice(-16000) ?? ""
          }
        })
      )
      .handle(
        "stop",
        Effect.fn("Processes.stop")(function* ({ payload }) {
          const row = last?.processes.find((item) => item.key === payload.key)
          if (row === undefined || row.owner.kind !== "command" || !row.can_stop)
            return yield* new HttpApiError.NotFound({})
          const terminal = terminals.get(row.owner.terminal_id)
          if (
            terminal === undefined ||
            terminal.exit !== undefined ||
            terminal.sessionId !== row.owner.session_id
          )
            return yield* new HttpApiError.Conflict({})
          const counters = yield* readProcessCounters().pipe(
            Effect.mapError(() => new HttpApiError.Conflict({}))
          )
          const target = processStopTarget({ row, counters, terminals: terminals.all() })
          if (target === undefined) return yield* new HttpApiError.Conflict({})
          terminals.kill(target.id, { notify: false })
          return { ok: true }
        })
      )
  })
).pipe(Layer.provide(NodeServices.layer))
