import type { OperationalEvent } from "@arden-hq/protocol/daemon"
import { Context, DateTime, Effect, Layer } from "effect"
import { operationalEvent, type OperationalEventInput } from "./operational-events.js"
import type { StartupPhase } from "./startup-phase.js"

export interface MigrationProgress {
  readonly step: number
  readonly total: number
  readonly name: string
}

export interface DiagnosticsReporter {
  readonly startupPhase: (phase: StartupPhase) => void
  readonly migration: (progress: MigrationProgress) => void
  readonly operational: (event: OperationalEvent) => void
}

export interface DiagnosticsService {
  readonly startupPhase: (phase: StartupPhase) => Effect.Effect<void>
  readonly migration: (progress: MigrationProgress) => Effect.Effect<void>
  readonly operational: (input: OperationalEventInput) => Effect.Effect<void>
}

export const Diagnostics = Context.Reference<DiagnosticsService>(
  "@arden-hq/server/runtime/Diagnostics",
  {
    defaultValue: () => ({
      startupPhase: () => Effect.void,
      migration: () => Effect.void,
      operational: () => Effect.void
    })
  }
)

const quietly = (emit: () => void): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      emit()
    } catch {}
  })

export const diagnosticsLayer = (reporter: DiagnosticsReporter): Layer.Layer<never> =>
  Layer.succeed(Diagnostics, {
    startupPhase: (phase) => quietly(() => reporter.startupPhase(phase)),
    migration: (progress) => quietly(() => reporter.migration(progress)),
    operational: (input) =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          quietly(() => reporter.operational(operationalEvent(input, DateTime.formatIso(now))))
        )
      )
  })
