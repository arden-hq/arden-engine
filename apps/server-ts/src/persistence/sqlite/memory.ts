import { Effect, Schema } from "effect"

import {
  MemoryCaptureBatchIdentitySchema,
  MemoryCaptureStore,
  MemoryCaptureStoreError,
  type MemoryCaptureBatchIdentity
} from "../memory/store.js"
import {
  advanceCapture,
  listCaptureBacklog,
  listCaptureWork,
  prepareCapture,
  readCaptureBacklog
} from "./memory-capture-positions.js"
import type { PersistenceDeps } from "./deps.js"

const failed =
  (operation: MemoryCaptureStoreError["operation"], message: string, sessionId?: string) =>
  (cause: unknown) =>
    new MemoryCaptureStoreError({
      operation,
      message,
      ...(sessionId === undefined ? {} : { sessionId }),
      cause
    })

export const makeMemoryCaptureStore = ({
  writer
}: Pick<PersistenceDeps, "writer">): MemoryCaptureStore["Service"] => {
  const listWork = Effect.fn("SqliteMemoryCaptureStore.listWork")(function* (limit = 8) {
    const valid = yield* Schema.decodeUnknownEffect(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
    )(limit).pipe(Effect.mapError(failed("list", "Invalid Memory capture page limit")))
    return yield* listCaptureWork(writer.sql, valid).pipe(
      Effect.mapError(failed("list", "Could not list Memory capture work"))
    )
  })

  const move = (operation: "prepare" | "advance", write: typeof prepareCapture, message: string) =>
    Effect.fn(`SqliteMemoryCaptureStore.${operation}`)(function* (
      batch: MemoryCaptureBatchIdentity
    ) {
      const valid = yield* Schema.decodeUnknownEffect(MemoryCaptureBatchIdentitySchema)(batch).pipe(
        Effect.mapError(failed(operation, "Invalid Memory capture batch", batch.sessionId))
      )
      return yield* writer
        .transact(write(writer.sql, valid))
        .pipe(Effect.mapError(failed(operation, message, valid.sessionId)))
    })

  return MemoryCaptureStore.of({
    listWork,
    prepare: move("prepare", prepareCapture, "Could not prepare a Memory capture batch"),
    advance: move("advance", advanceCapture, "Could not advance Memory capture"),
    listBacklog: () =>
      listCaptureBacklog(writer.sql).pipe(
        Effect.mapError(failed("list", "Could not list the Memory capture backlog"))
      ),
    readBacklog: (read) =>
      writer
        .transact(readCaptureBacklog(writer.sql, read))
        .pipe(
          Effect.mapError(
            failed("advance", "Could not record a read backlog range", read.sessionId)
          )
        )
  })
}
