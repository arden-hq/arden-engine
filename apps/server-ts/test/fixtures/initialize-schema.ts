import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"

import { LATEST_SCHEMA_VERSION } from "../../src/persistence/migrations/index.js"
import { databaseSchema } from "../../src/persistence/schema/database.js"

export const initializeSchema = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql.unsafe("PRAGMA foreign_keys = ON")
    yield* sql.withTransaction(
      Effect.forEach(databaseSchema.statements, (statement) => sql.unsafe(statement), {
        discard: true
      }).pipe(Effect.andThen(sql.unsafe(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`)))
    )
  })
