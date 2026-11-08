import type { JobWorker } from "@arden-hq/jobs"
import { Context, Effect, Layer } from "effect"

export class WorkerStatus extends Context.Service<
  WorkerStatus,
  {
    readonly attach: (worker: JobWorker) => () => void
    readonly read: () => ReturnType<JobWorker["snapshot"]> | undefined
  }
>()("@arden-hq/server/automations/WorkerStatus") {
  static readonly layer = Layer.effect(
    WorkerStatus,
    Effect.sync(() => {
      let current: JobWorker | undefined
      return WorkerStatus.of({
        attach: (worker) => {
          current = worker
          return () => {
            if (current === worker) current = undefined
          }
        },
        read: () => current?.snapshot()
      })
    })
  )
}
