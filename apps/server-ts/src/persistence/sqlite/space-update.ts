import { captureMutationVersions } from "./mutation-links.js"
import { type UpdateSpaceInput, SPACE_EXPECTED } from "@arden-hq/protocol/spaces"
import { assertPersonRun } from "./person-run.js"
import { UpdateSpaceInputSchema } from "@arden-hq/protocol/effect/spaces"
import { DateTime, Effect, Schema, type SchemaAST } from "effect"
import { SpaceStoreError, type PersistedSpace, type SpaceStore } from "../spaces/store.js"
import { followSpaceName } from "./owner-chat.js"
import type { PersistenceDeps } from "./deps.js"
import { decodeRow, storeError, type SpaceRow } from "./space-row.js"
import { applySpaceChanges } from "./space-changes.js"
import type { SpaceJobSql } from "./space-job-types.js"

export const strict: SchemaAST.ParseOptions = { onExcessProperty: "error" }

export const makeSpaceUpdate = ({
  writer,
  spaceJobs
}: Pick<PersistenceDeps, "writer"> & {
  readonly spaceJobs: SpaceJobSql
}): SpaceStore["Service"]["update"] => {
  const sql = writer.sql
  const update = Effect.fn("SqliteSpaceStore.update")(function* (
    spaceId: string,
    input: UpdateSpaceInput,
    runId?: string,
    toolCallId?: string
  ): Effect.fn.Return<PersistedSpace | null, SpaceStoreError> {
    const validSpaceId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(spaceId).pipe(
      Effect.mapError((cause) =>
        storeError("update", "invalid", "Space id must not be empty", undefined, cause)
      )
    )
    const valid = yield* Schema.decodeUnknownEffect(UpdateSpaceInputSchema)(input, strict).pipe(
      Effect.mapError((cause) =>
        storeError("update", "invalid", "Invalid Space update", validSpaceId, cause)
      )
    )
    const now = DateTime.formatIso(yield* DateTime.now)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const recordVersions = yield* captureMutationVersions(sql, {
            domain: "space",
            id: validSpaceId,
            identity:
              runId !== undefined && toolCallId !== undefined ? { runId, toolCallId } : undefined
          })
          if (runId !== undefined)
            yield* assertPersonRun(sql, runId).pipe(
              Effect.mapError((cause) =>
                storeError("update", "conflict", cause.message, validSpaceId, cause)
              )
            )
          const rows = yield* sql<SpaceRow & { readonly policy_generation: number }>`
        SELECT space_id, name, instructions, instructions_source, page_path, page_id,
               inference_policy, mark, kind, created_at, updated_at, archived_at,
               policy_generation
        FROM spaces
        WHERE space_id = ${validSpaceId} AND archived_at IS NULL
        LIMIT 1
      `
          const row = rows[0]
          if (row === undefined) return null
          const current = yield* decodeRow(row, "update")
          if (
            valid.expected.kind === SPACE_EXPECTED.at &&
            valid.expected.updated_at !== current.updated_at
          ) {
            return yield* storeError(
              "update",
              "conflict",
              "This Space changed. Reload it and try again.",
              validSpaceId
            )
          }
          const updatedAt =
            now > current.updated_at
              ? now
              : DateTime.formatIso(
                  DateTime.add(DateTime.makeUnsafe(current.updated_at), { milliseconds: 1 })
                )
          const edit = applySpaceChanges(current, valid.changes)
          const name = edit.name
          const nameKey = name.toLowerCase()
          const duplicate = yield* sql<{ readonly space_id: string }>`
        SELECT space_id FROM spaces
        WHERE name_key = ${nameKey}
          AND space_id != ${validSpaceId}
          AND archived_at IS NULL
        LIMIT 1
      `
          if (duplicate.length > 0) {
            return yield* storeError(
              "update",
              "conflict",
              "An active Space already has that name. Pick another.",
              validSpaceId
            )
          }
          const instructions = edit.instructions
          const instructionsSource = edit.instructions_source
          const mark = edit.mark
          const updated = yield* sql<SpaceRow>`
        UPDATE spaces
        SET name = ${name}, name_key = ${nameKey},
            instructions = ${instructions}, instructions_source = ${instructionsSource},
            mark = ${mark === null ? null : JSON.stringify(mark)},
            updated_at = ${updatedAt}
        WHERE space_id = ${validSpaceId} AND archived_at IS NULL
        RETURNING space_id, name, instructions, instructions_source, page_path, page_id,
                  inference_policy, mark, kind, created_at, updated_at, archived_at
      `
          const next = updated[0]
          if (next === undefined) return null
          if (current.name !== name) yield* followSpaceName(sql, validSpaceId, current.name, name)
          if (edit.instructionsChanged)
            yield* spaceJobs.queueOwnerSpaceChangeWake(validSpaceId, now, runId)
          else yield* spaceJobs.syncSpace(validSpaceId, now)
          const generations = yield* sql<{ readonly policy_generation: number }>`
        SELECT policy_generation FROM spaces WHERE space_id = ${validSpaceId}`
          if (generations[0]?.policy_generation !== row.policy_generation) {
          }
          yield* recordVersions
          return yield* decodeRow(next, "update")
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SpaceStoreError
            ? cause
            : storeError("update", "storage", "Could not update Space", validSpaceId, cause)
        )
      )
  })
  return update
}
