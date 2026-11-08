import { Context, Effect, Exit, Layer } from "effect"
import {
  fullContext,
  type ContextExperimentReport,
  type ContextRun,
  type ContextSelection,
  type ContextStage
} from "@arden-hq/protocol/context"
import type { ModelPhaseTiming } from "@arden-hq/protocol/daemon"

export const makeContextExperiments = (clock: () => number = () => performance.now()) => {
  const selections = new Map<string, ContextSelection>()
  const runSelections = new Map<string, ContextSelection>()
  const runs = new Map<string, { sessionId: string; active: boolean; report: ContextRun }>()
  const trim = () => {
    const completed = [...runs].filter(([, run]) => !run.active)
    for (const [id] of completed.slice(0, -200)) runs.delete(id)
  }
  const begin = (sessionId: string, runId: string, personal: boolean): ContextSelection => {
    const existing = runs.get(runId)
    if (existing !== undefined) {
      existing.active = true
      return existing.report.selection
    }
    const selection = runSelections.get(runId) ?? {
      ...(personal ? (selections.get(sessionId) ?? fullContext) : fullContext)
    }
    runSelections.set(runId, selection)
    runs.set(runId, {
      sessionId,
      active: true,
      report: { runId, selection, stages: [], phases: [] }
    })
    return selection
  }
  const stage = (runId: string, value: ContextStage) => {
    const run = runs.get(runId)
    if (run !== undefined)
      run.report = { ...run.report, stages: [...run.report.stages.slice(-199), value] }
  }
  const start = (runId: string, part: ContextStage["part"]) => {
    const began = clock()
    let recorded = false
    return (outcome: ContextStage["outcome"]) => {
      if (recorded) return
      recorded = true
      stage(runId, { part, durationMs: Math.max(0, Math.round(clock() - began)), outcome })
    }
  }
  const measure = Effect.fn("ContextExperiments.measure")(function* <A, E, R>(
    runId: string,
    part: ContextStage["part"],
    enabled: boolean,
    operation: Effect.Effect<A, E, R>,
    skipped: A
  ) {
    if (!enabled) {
      stage(runId, { part, durationMs: 0, outcome: "skipped" })
      return skipped
    }
    const finish = start(runId, part)
    return yield* operation.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => finish(Exit.isSuccess(exit) ? "completed" : "failed"))
      )
    )
  })
  return {
    begin,
    start,
    measure,
    finish: (runId: string) => {
      const run = runs.get(runId)
      if (run !== undefined) run.active = false
      trim()
    },
    set: (sessionId: string, selection: ContextSelection) => {
      selections.delete(sessionId)
      selections.set(sessionId, { ...selection })
    },
    phase: (runId: string, timing: ModelPhaseTiming) => {
      const run = runs.get(runId)
      if (run !== undefined)
        run.report = { ...run.report, phases: [...run.report.phases.slice(-599), timing] }
    },
    report: (sessionId: string): ContextExperimentReport => ({
      sessionId,
      selection: selections.get(sessionId) ?? fullContext,
      runs: [...runs.values()].filter((run) => run.sessionId === sessionId).map((run) => run.report)
    })
  }
}

export const ContextExperiments = Context.Reference<ReturnType<typeof makeContextExperiments>>(
  "@arden-hq/server/ContextExperiments",
  { defaultValue: () => makeContextExperiments() }
)
export const contextExperimentsLayer = Layer.sync(ContextExperiments, makeContextExperiments)
