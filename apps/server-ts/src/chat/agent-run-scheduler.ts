import { Effect, Exit, Semaphore } from "effect"
import type { ChatRunScheduling } from "../persistence/chat/store.js"
import { Diagnostics } from "../runtime/diagnostics.js"

interface RunIdentity {
  readonly runId: string
  readonly sessionId: string
}

export interface AgentRunScheduler {
  readonly run: <A, E, R>(
    scheduling: ChatRunScheduling,
    effect: Effect.Effect<A, E, R>,
    identity?: RunIdentity
  ) => Effect.Effect<A, E, R>
}

export const makeAgentRunScheduler = (): AgentRunScheduler => {
  const barriers = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>()

  return {
    run: (scheduling, effect, identity) =>
      Effect.suspend(() => {
        const startedAt = performance.now()
        let acquiredAt: number | undefined
        const execute = Effect.suspend(() => {
          acquiredAt = performance.now()
          return effect.pipe(Effect.withSpan("ChatAgentRun.execute"))
        })
        const scheduled =
          scheduling.kind === "unrestricted"
            ? execute
            : Effect.acquireUseRelease(
                Effect.sync(() => {
                  const existing = barriers.get(scheduling.treeRootSessionId)
                  const barrier = existing ?? {
                    semaphore: Semaphore.makeUnsafe(scheduling.maxConcurrentAgents),
                    users: 0
                  }
                  if (existing === undefined) barriers.set(scheduling.treeRootSessionId, barrier)
                  barrier.users += 1
                  return barrier
                }),
                (barrier) =>
                  barrier.semaphore
                    .resize(scheduling.maxConcurrentAgents)
                    .pipe(Effect.andThen(barrier.semaphore.withPermit(execute))),
                (barrier) =>
                  Effect.sync(() => {
                    barrier.users -= 1
                    if (barrier.users === 0) barriers.delete(scheduling.treeRootSessionId)
                  })
              )
        if (identity === undefined) return scheduled
        return scheduled.pipe(
          Effect.onExit((exit) =>
            Effect.flatMap(Diagnostics, (diagnostics) => {
              const finishedAt = performance.now()
              const elapsed = (since: number) => Math.max(0, Math.round(finishedAt - since))
              let outcome: "completed" | "interrupted" | "failed" = "failed"
              if (Exit.isSuccess(exit)) outcome = "completed"
              else if (Exit.hasInterrupts(exit)) outcome = "interrupted"
              return diagnostics.operational({
                code: "chat.agent_run_timing",
                severity: "info",
                cause: null,
                ...identity,
                waitMs:
                  acquiredAt === undefined
                    ? elapsed(startedAt)
                    : Math.max(0, Math.round(acquiredAt - startedAt)),
                executionMs: acquiredAt === undefined ? null : elapsed(acquiredAt),
                outcome
              })
            })
          )
        )
      })
  }
}
