import type { HeldToolCall } from "@arden-hq/loop"
import { isTerminalRunStatus } from "@arden-hq/protocol/runs"
import { Effect } from "effect"

export interface HeldBackground {
  readonly hold: (runId: string, calls: ReadonlyArray<HeldToolCall>) => void
  readonly claim: (
    runId: string,
    toolCallIds: ReadonlyArray<string>
  ) => ReadonlyMap<string, HeldToolCall>
  readonly held: (runId: string) => ReadonlySet<string>
  readonly stop: (runIds?: ReadonlyArray<string>) => void
}

export const makeHeldBackground = (): HeldBackground => {
  const runs = new Map<string, Map<string, HeldToolCall>>()
  return {
    hold: (runId, calls) => {
      const held = runs.get(runId) ?? new Map<string, HeldToolCall>()
      runs.set(runId, held)
      for (const call of calls) {
        held.set(call.toolCallId, call)
        void call.result.finally(() => {
          if (held.get(call.toolCallId) === call) held.delete(call.toolCallId)
          if (held.size === 0 && runs.get(runId) === held) runs.delete(runId)
        })
      }
    },
    claim: (runId, toolCallIds) => {
      const held = runs.get(runId)
      return new Map(
        toolCallIds.flatMap((id) => {
          const call = held?.get(id)
          return call === undefined ? [] : [[id, call] as const]
        })
      )
    },
    held: (runId) => new Set(runs.get(runId)?.keys()),
    stop: (runIds) => {
      for (const runId of runIds ?? [...runs.keys()])
        for (const call of runs.get(runId)?.values() ?? []) call.stop()
    }
  }
}

export const stopHeldOfEndedRuns = Effect.fn("HeldBackground.stopHeldOfEndedRuns")(function* (
  heldBackground: HeldBackground,
  runs: {
    readonly get: (runId: string) => Effect.Effect<{ readonly status: string } | null, unknown>
  },
  runIds: ReadonlyArray<string>
) {
  for (const runId of runIds) {
    if (heldBackground.held(runId).size === 0) continue
    const run = yield* runs.get(runId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Could not check whether a run with held calls ended", { runId, cause })
      ),
      Effect.option
    )
    if (run._tag === "None") continue
    if (run.value === null || isTerminalRunStatus(run.value.status)) heldBackground.stop([runId])
  }
})
