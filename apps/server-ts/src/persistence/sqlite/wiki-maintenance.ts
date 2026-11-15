import { Effect } from "effect"

import {
  WikiMaintenanceStore,
  WikiMaintenanceStoreError,
  type WikiMaintenanceCompareAndSetInput,
  type WikiMaintenanceStoreOperation
} from "../wiki-maintenance/store.js"
import type { PersistenceDeps } from "./deps.js"
import { MemoryHistoryPositionError, memoryHistoryPosition } from "./memory-history-position.js"

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

const reasonOf = (cause: MemoryHistoryPositionError): WikiMaintenanceStoreError["reason"] => {
  switch (cause.reason) {
    case "missing":
      return "storage"
    case "corrupt":
    case "invalid":
      return cause.reason
  }
}

const mapStorage =
  (operation: WikiMaintenanceStoreOperation, message: string) =>
  (cause: unknown): WikiMaintenanceStoreError => {
    if (cause instanceof WikiMaintenanceStoreError) return cause
    if (cause instanceof MemoryHistoryPositionError)
      return error(operation, reasonOf(cause), cause.message, cause)
    return error(operation, "storage", message, cause)
  }

export const makeWikiMaintenanceStore = ({
  writer
}: Pick<PersistenceDeps, "writer">): WikiMaintenanceStore["Service"] => {
  const sql = writer.sql
  const position = memoryHistoryPosition("maintenance")

  const initialize = (processedHead: string | null) =>
    writer
      .transact(position.start(sql, processedHead))
      .pipe(
        Effect.mapError(mapStorage("initialize", "Could not initialize Wiki Maintenance watermark"))
      )

  const processedHead = () =>
    position
      .read(sql)
      .pipe(Effect.mapError(mapStorage("read", "Could not read Wiki Maintenance watermark")))

  const compareAndSet = (input: WikiMaintenanceCompareAndSetInput) =>
    writer
      .transact(
        position
          .advance(sql, input)
          .pipe(
            Effect.flatMap((moved) =>
              moved === "moved"
                ? Effect.fail(
                    error(
                      "compare_and_set",
                      "conflict",
                      "Wiki Maintenance watermark changed before advance"
                    )
                  )
                : Effect.succeed(input.next)
            )
          )
      )
      .pipe(
        Effect.mapError(
          mapStorage("compare_and_set", "Could not complete Wiki Maintenance watermark advance")
        )
      )

  return WikiMaintenanceStore.of({ initialize, processedHead, compareAndSet })
}
