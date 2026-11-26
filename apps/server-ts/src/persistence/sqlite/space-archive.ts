import { captureMutationVersions } from "./mutation-links.js"
import type { MutationOperationIdentity } from "../tools/mutation-receipt.js"
import { type SpaceKind, type SpaceArchiveResponse } from "@arden-hq/protocol/spaces"
import { SpaceArchiveResponseSchema } from "@arden-hq/protocol/effect/spaces"
import { DateTime, Effect, Schema } from "effect"
import { SpaceStoreError, archiveRefusal, type SpaceStore } from "../spaces/store.js"
import type { PersistenceDeps } from "./deps.js"
import { pauseForArchivedSpace } from "./automation-auto-pause.js"
import { archiveSpaceChats } from "./space-chat-archive.js"
import { chatHasActiveWork } from "./session-archive.js"
import { storeError } from "./space-row.js"
import type { SpaceJobSql } from "./space-job-types.js"

export const makeSpaceArchive = ({
  writer,
  sessionEvents,
  spaceJobs
}: Pick<PersistenceDeps, "writer" | "sessionEvents"> & {
  readonly spaceJobs: SpaceJobSql
}): SpaceStore["Service"]["archive"] => {
  const sql = writer.sql
  const archive = Effect.fn("SqliteSpaceStore.archive")(function* (
    spaceId: string,
    mutation?: MutationOperationIdentity
  ): Effect.fn.Return<SpaceArchiveResponse | null, SpaceStoreError> {
    const validSpaceId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(spaceId).pipe(
      Effect.mapError((cause) =>
        storeError("archive", "invalid", "Space id must not be empty", undefined, cause)
      )
    )
    const timestamp = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const recordVersions = yield* captureMutationVersions(sql, {
            domain: "space",
            id: validSpaceId,
            identity: mutation
          })
          const active = yield* sql<{ readonly kind: SpaceKind }>`
        SELECT kind FROM spaces
        WHERE space_id = ${validSpaceId} AND archived_at IS NULL
        LIMIT 1
      `.pipe(
            Effect.mapError((cause) =>
              storeError("archive", "storage", "Could not read Space", validSpaceId, cause)
            )
          )
          if (active[0] === undefined) return null
          const refusal = archiveRefusal(active[0])
          if (refusal !== undefined)
            return yield* storeError("archive", "conflict", refusal, validSpaceId)
          const busy = yield* sql`SELECT 1 FROM sessions AS s
            WHERE s.space_id = ${validSpaceId} AND s.archived_at IS NULL
              AND ${chatHasActiveWork(sql, sql`s`)} LIMIT 1`
          if (busy.length > 0) {
            return yield* storeError(
              "archive",
              "conflict",
              "A chat on this Space has work running",
              validSpaceId
            )
          }
          yield* sql`
        UPDATE spaces
        SET archived_at = ${timestamp}, updated_at = ${timestamp}, pinned_position = NULL
        WHERE space_id = ${validSpaceId} AND archived_at IS NULL
      `.pipe(
            Effect.mapError((cause) =>
              storeError("archive", "storage", "Could not archive Space", validSpaceId, cause)
            )
          )
          yield* spaceJobs.syncSpace(validSpaceId, timestamp)
          yield* pauseForArchivedSpace({ sql, sessionEvents, spaceId: validSpaceId, mutation })
          yield* archiveSpaceChats(sql, validSpaceId, timestamp)
          const response = yield* Schema.decodeUnknownEffect(SpaceArchiveResponseSchema)({
            status: "archived",
            space_id: validSpaceId
          }).pipe(
            Effect.mapError((cause) =>
              storeError(
                "archive",
                "storage",
                "Space archive response is corrupt",
                validSpaceId,
                cause
              )
            )
          )
          yield* recordVersions
          return response
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SpaceStoreError
            ? cause
            : storeError(
                "archive",
                "storage",
                "Could not complete Space archive",
                validSpaceId,
                cause
              )
        )
      )
  })
  return archive
}
