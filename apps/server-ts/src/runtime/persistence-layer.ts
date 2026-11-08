import { Effect, Layer } from "effect"
import { automationRulesLayer } from "../automations/rules.js"
import { chatRulesLayer } from "../chat/rules.js"
import { Persistence, type StorageStartupError } from "../persistence/service.js"
import type { PersistenceWriteQueue } from "../persistence/write-queue.js"
import {
  sqliteStoresLayer,
  type SqlitePersistence,
  type SqlitePersistenceOptions
} from "../persistence/sqlite/layer.js"
import { Diagnostics } from "./diagnostics.js"
import { ServerLifecycle } from "./lifecycle.js"

export { prepareReleaseStorage } from "../persistence/sqlite/release-safety.js"
export type { SqlitePersistenceOptions } from "../persistence/sqlite/layer.js"

const sqlitePersistenceLayer = (
  options: SqlitePersistenceOptions
): Layer.Layer<SqlitePersistence, StorageStartupError, PersistenceWriteQueue> =>
  sqliteStoresLayer(options).pipe(Layer.provide(Layer.merge(automationRulesLayer, chatRulesLayer)))

const FIRST_RETENTION_DELAY = "2 minutes"

const persistenceBootLayer: Layer.Layer<never, StorageStartupError, Persistence> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const persistence = yield* Persistence
      const diagnostics = yield* Diagnostics
      const lifecycle = yield* ServerLifecycle
      yield* persistence.recoverAfterRestart
      yield* diagnostics.startupPhase("recovery_ready")
      yield* lifecycle.background(
        Effect.sleep(FIRST_RETENTION_DELAY).pipe(
          Effect.andThen(
            persistence.retentionTick.pipe(
              Effect.catchCause((cause) => Effect.logWarning("Storage retention failed", cause)),
              Effect.andThen(Effect.sleep("1 hour")),
              Effect.forever
            )
          )
        )
      )
    })
  )

export const recoveredSqlitePersistenceLayer = (
  options: SqlitePersistenceOptions
): Layer.Layer<SqlitePersistence, StorageStartupError, PersistenceWriteQueue> =>
  persistenceBootLayer.pipe(Layer.provideMerge(sqlitePersistenceLayer(options)))
