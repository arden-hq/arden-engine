import { SqliteClient } from "@effect/sql-sqlite-node"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import type { SqlClient } from "effect/unstable/sql"

import type { StorageStartupError } from "../../src/persistence/service.js"
import type { SqlitePersistence } from "../../src/persistence/sqlite/layer.js"
import { PersistenceWriteQueue } from "../../src/persistence/write-queue.js"
import { automationRulesLayer } from "../../src/automations/rules.js"
import { chatRulesLayer } from "../../src/chat/rules.js"
import {
  sqliteStoresLayer,
  type SqlitePersistenceOptions
} from "../../src/persistence/sqlite/layer.js"

export const sqlitePersistenceLayer = (
  options: SqlitePersistenceOptions
): Layer.Layer<SqlitePersistence, StorageStartupError, PersistenceWriteQueue> =>
  sqliteStoresLayer(options).pipe(Layer.provide(Layer.merge(automationRulesLayer, chatRulesLayer)))

export const withTempDatabaseFile = async <A>(
  use: (filename: string) => Promise<A>
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "arden-test-db-"))
  try {
    return await use(join(directory, "arden.db"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export const runTestDatabase = <A, E>(
  filename: string,
  body: Effect.Effect<A, E, SqlitePersistence | SqlClient.SqlClient>
): Promise<A> =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(
        Layer.merge(
          sqlitePersistenceLayer({ dataDir: null, filename }).pipe(
            Layer.provide(PersistenceWriteQueue.layer)
          ),
          SqliteClient.layer({ filename })
        )
      )
    )
  )

export const withTempDatabase = <A, E>(
  body: Effect.Effect<A, E, SqlitePersistence | SqlClient.SqlClient>
): Promise<A> => withTempDatabaseFile((filename) => runTestDatabase(filename, body))
