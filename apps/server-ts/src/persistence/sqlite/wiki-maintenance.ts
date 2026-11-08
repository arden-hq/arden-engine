import { DateTime, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"

import {
  WikiMaintenanceStore,
  WikiMaintenanceStoreError,
  type WikiMaintenanceCompareAndSetInput,
  type WikiMaintenanceStoreOperation
} from "../wiki-maintenance/store.js"
import type { PersistenceDeps } from "./deps.js"

const NAMESPACE = "wiki_maintenance"
const RevisionSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
const StateSchema = Schema.Struct({
  processedHead: Schema.NullOr(RevisionSchema)
})
const StateJsonSchema = Schema.fromJsonString(StateSchema)
const CompareAndSetInputSchema = Schema.Struct({
  expected: Schema.NullOr(RevisionSchema),
  next: RevisionSchema
})

interface StateRow {
  readonly state: string
}

const error = (
  operation: WikiMaintenanceStoreOperation,
  reason: WikiMaintenanceStoreError["reason"],
  message: string,
  cause?: unknown
): WikiMaintenanceStoreError =>
  new WikiMaintenanceStoreError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const mapStorage =
  (operation: WikiMaintenanceStoreOperation, message: string) =>
  (cause: unknown): WikiMaintenanceStoreError =>
    cause instanceof WikiMaintenanceStoreError ? cause : error(operation, "storage", message, cause)

const decodeState = (value: string, operation: WikiMaintenanceStoreOperation) =>
  Schema.decodeUnknownEffect(StateJsonSchema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) =>
      error(operation, "corrupt", "Stored Wiki Maintenance watermark is corrupt", cause)
    )
  )

const encodeState = (processedHead: string | null, operation: WikiMaintenanceStoreOperation) =>
  Schema.encodeEffect(StateJsonSchema)({ processedHead }).pipe(
    Effect.mapError((cause) =>
      error(operation, "invalid", "Invalid Wiki Maintenance processed head", cause)
    )
  )

const readState = Effect.fn("SqliteWikiMaintenanceStore.readState")(function* (
  sql: SqlClient.SqlClient,
  operation: WikiMaintenanceStoreOperation
) {
  const rows = yield* sql<StateRow>`
    SELECT state FROM monitor_state WHERE namespace = ${NAMESPACE} LIMIT 1
  `.pipe(Effect.mapError(mapStorage(operation, "Could not read Wiki Maintenance watermark")))
  const row = rows[0]
  if (row === undefined) {
    return yield* error(operation, "storage", "Wiki Maintenance watermark is not initialized")
  }
  const state = yield* decodeState(row.state, operation)
  return { raw: row.state, processedHead: state.processedHead }
})

export const makeWikiMaintenanceStore = ({
  writer
}: Pick<PersistenceDeps, "writer">): WikiMaintenanceStore["Service"] => {
  const sql = writer.sql
  const initialize = Effect.fn("SqliteWikiMaintenanceStore.initialize")(function* (
    processedHead: string | null
  ): Effect.fn.Return<string | null, WikiMaintenanceStoreError> {
    const state = yield* encodeState(processedHead, "initialize")
    const updatedAt = DateTime.formatIso(yield* DateTime.now)
    yield* writer.run(
      sql`
      INSERT INTO monitor_state (namespace, state, updated_at)
      VALUES (${NAMESPACE}, ${state}, ${updatedAt})
      ON CONFLICT(namespace) DO NOTHING
    `.pipe(
        Effect.mapError(mapStorage("initialize", "Could not initialize Wiki Maintenance watermark"))
      )
    )
    return (yield* readState(sql, "initialize")).processedHead
  })

  const processedHead = Effect.fn("SqliteWikiMaintenanceStore.processedHead")(function* () {
    return (yield* readState(sql, "read")).processedHead
  })

  const compareAndSet = Effect.fn("SqliteWikiMaintenanceStore.compareAndSet")(function* (
    input: WikiMaintenanceCompareAndSetInput
  ): Effect.fn.Return<string | null, WikiMaintenanceStoreError> {
    const valid = yield* Schema.decodeUnknownEffect(CompareAndSetInputSchema)(input, {
      onExcessProperty: "error"
    }).pipe(
      Effect.mapError((cause) =>
        error("compare_and_set", "invalid", "Invalid Wiki Maintenance watermark transition", cause)
      )
    )
    const next = yield* encodeState(valid.next, "compare_and_set")
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const current = yield* readState(sql, "compare_and_set")
          if (current.processedHead === valid.next) return current.processedHead
          if (current.processedHead !== valid.expected) {
            return yield* error(
              "compare_and_set",
              "conflict",
              "Wiki Maintenance watermark changed before advance"
            )
          }
          const updatedAt = DateTime.formatIso(yield* DateTime.now)
          const rows = yield* sql<StateRow>`
          UPDATE monitor_state
          SET state = ${next}, updated_at = ${updatedAt}
          WHERE namespace = ${NAMESPACE} AND state = ${current.raw}
          RETURNING state
        `.pipe(
            Effect.mapError(
              mapStorage("compare_and_set", "Could not advance Wiki Maintenance watermark")
            )
          )
          const row = rows[0]
          if (row === undefined) {
            return yield* error(
              "compare_and_set",
              "conflict",
              "Wiki Maintenance watermark changed before advance"
            )
          }
          return (yield* decodeState(row.state, "compare_and_set")).processedHead
        })
      )
      .pipe(
        Effect.mapError(
          mapStorage("compare_and_set", "Could not complete Wiki Maintenance watermark advance")
        )
      )
  })

  return WikiMaintenanceStore.of({ initialize, processedHead, compareAndSet })
}
