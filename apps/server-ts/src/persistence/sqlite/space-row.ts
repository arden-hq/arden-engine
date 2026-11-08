import {
  SpaceSchema,
  StoredSpaceMarkLookSchema,
  TaskInferencePolicySchema
} from "@arden-hq/protocol/effect/spaces"
import { Effect, Schema } from "effect"
import { SpaceStoreError, type PersistedSpace } from "../spaces/store.js"
import { decodeJson } from "./json.js"

export interface SpaceRow {
  readonly space_id: string
  readonly name: string
  readonly instructions: string | null
  readonly instructions_source: string | null
  readonly page_path: string | null
  readonly page_id: string | null
  readonly inference_policy: string
  readonly mark: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly archived_at: string | null
}

export const storeError = (
  operation: SpaceStoreError["operation"],
  reason: "invalid" | "conflict" | "storage",
  message: string,
  spaceId?: string,
  cause?: unknown
) =>
  new SpaceStoreError({
    operation,
    reason,
    message,
    ...(spaceId === undefined ? {} : { spaceId }),
    ...(cause === undefined ? {} : { cause })
  })

export const decodeRow = Effect.fn("SqliteSpaceStore.decodeRow")(function* (
  row: SpaceRow,
  operation: "list" | "create" | "get" | "update" | "restore" | "page" | "detail" | "overview"
): Effect.fn.Return<PersistedSpace, SpaceStoreError> {
  const mark =
    row.mark === null
      ? null
      : yield* decodeJson(StoredSpaceMarkLookSchema, row.mark).pipe(
          Effect.orElseSucceed(() => null)
        )
  const decoded = yield* Schema.decodeUnknownEffect(SpaceSchema)({
    inference: yield* decodeJson(TaskInferencePolicySchema, row.inference_policy).pipe(
      Effect.mapError((cause) =>
        storeError(
          operation,
          "storage",
          "Stored Task inference policy is corrupt",
          row.space_id,
          cause
        )
      )
    ),
    space_id: row.space_id,
    name: row.name,
    instructions: row.instructions,
    instructions_source: row.instructions_source,
    page_path: row.page_path,
    mark,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at
  }).pipe(
    Effect.mapError((cause) =>
      storeError(operation, "storage", "Stored Space row is corrupt", row.space_id, cause)
    )
  )
  const pageId = yield* Schema.decodeUnknownEffect(Schema.NullOr(Schema.String))(row.page_id).pipe(
    Effect.mapError((cause) =>
      storeError(operation, "storage", "Stored Space page identity is corrupt", row.space_id, cause)
    )
  )
  return { ...decoded, page_id: pageId }
})
