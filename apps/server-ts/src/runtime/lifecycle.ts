import { Cause, Context, Deferred, Effect, FiberSet, Layer, type Scope } from "effect"

type Phase = "starting" | "ready" | "quiescing" | "closing" | "stopped"

export interface ServerLifecycleShape {
  readonly awaitReady: Effect.Effect<void>
  readonly quiescing: Effect.Effect<void>
  readonly settled: Effect.Effect<void>
  readonly acceptedSettled: Effect.Effect<void>
  readonly isAccepting: () => boolean
  readonly ready: Effect.Effect<void>
  readonly quiesce: Effect.Effect<void>
  readonly close: Effect.Effect<void>
  readonly stopped: Effect.Effect<void>
  readonly accepted: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options: { readonly scope: Scope.Scope }
  ) => Effect.Effect<void, never, R>
  readonly background: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<void, never, R | Scope.Scope>
}

const background = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<void, never, R | Scope.Scope> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning("Server background work failed", { cause })
    ),
    Effect.forkScoped,
    Effect.asVoid
  )

const accepted: ServerLifecycleShape["accepted"] = (effect, { scope }) =>
  Effect.forkIn(
    effect.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Accepted server work failed", { cause })),
      Effect.uninterruptible
    ),
    scope
  ).pipe(Effect.asVoid)

export const ServerLifecycle = Context.Reference<ServerLifecycleShape>(
  "@arden-hq/server/runtime/ServerLifecycle",
  {
    defaultValue: () => ({
      awaitReady: Effect.void,
      quiescing: Effect.never,
      settled: Effect.void,
      acceptedSettled: Effect.void,
      isAccepting: () => true,
      ready: Effect.void,
      quiesce: Effect.void,
      close: Effect.void,
      stopped: Effect.void,
      accepted,
      background
    })
  }
)

export const serverLifecycleLayer = Layer.effect(
  ServerLifecycle,
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const quiescing = yield* Deferred.make<void>()
    const fibers = yield* FiberSet.make()
    const acceptedFibers = yield* FiberSet.make()
    let phase: Phase = "starting"
    const change = (next: Phase) =>
      Effect.sync(() => {
        phase = next
      })
    return ServerLifecycle.of({
      awaitReady: Deferred.await(ready),
      quiescing: Deferred.await(quiescing),
      settled: FiberSet.awaitEmpty(fibers),
      acceptedSettled: FiberSet.awaitEmpty(acceptedFibers),
      isAccepting: () => phase === "ready",
      ready: Effect.gen(function* () {
        if (phase !== "starting") return
        yield* change("ready")
        yield* Deferred.succeed(ready, undefined)
      }),
      quiesce: Effect.gen(function* () {
        if (phase !== "starting" && phase !== "ready") return
        yield* change("quiescing")
        yield* Deferred.succeed(quiescing, undefined)
      }),
      close: change("closing"),
      stopped: change("stopped"),
      accepted: (effect, { scope }) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (phase !== "ready") return
            const fiber = yield* Effect.forkIn(
              effect.pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Accepted server work failed", { cause })
                ),
                Effect.uninterruptible
              ),
              scope
            )
            yield* FiberSet.add(acceptedFibers, fiber)
          })
        ),
      background: (effect) =>
        FiberSet.run(
          fibers,
          Effect.raceFirst(
            Deferred.await(ready).pipe(
              Effect.andThen(
                Effect.suspend(() => (phase === "ready" ? Effect.scoped(effect) : Effect.void))
              )
            ),
            Deferred.await(quiescing)
          ).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logWarning("Server background work failed", { cause })
            )
          )
        ).pipe(Effect.asVoid)
    })
  })
)
