import { SpaceKindSchema, TaskInferencePolicySchema } from "@arden-hq/protocol/effect/spaces"
import { IsoDateTimeStringSchema } from "@arden-hq/protocol/effect/common"
import { Effect, Schema } from "effect"
import { StoredMarkLookSchema } from "../spaces/mark.js"
import { INSTRUCTIONS_SOURCE, SpaceStoreError, type PersistedSpace } from "../spaces/store.js"

const SpaceRecordSchema = Schema.Struct({
  inference: TaskInferencePolicySchema,
  space_id: Schema.NonEmptyString,
  kind: SpaceKindSchema,
  name: Schema.String,
  instructions: Schema.NullOr(Schema.String),
  instructions_source: Schema.NullOr(Schema.Literals(Object.values(INSTRUCTIONS_SOURCE))),
  page_path: Schema.NullOr(Schema.String),
  page_id: Schema.NullOr(Schema.String),
  mark: Schema.NullOr(StoredMarkLookSchema),
  created_at: IsoDateTimeStringSchema,
  updated_at: IsoDateTimeStringSchema,
  archived_at: Schema.NullOr(IsoDateTimeStringSchema)
})
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
  readonly kind: string
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
): SpaceStoreError =>
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
      : yield* decodeJson(StoredMarkLookSchema, row.mark).pipe(Effect.orElseSucceed(() => null))
  return yield* Schema.decodeUnknownEffect(SpaceRecordSchema)({
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
    kind: row.kind,
    name: row.name,
    instructions: row.instructions,
    instructions_source: row.instructions_source,
    page_path: row.page_path,
    page_id: row.page_id,
    mark,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at
  }).pipe(
    Effect.mapError((cause) =>
      storeError(operation, "storage", "Stored Space row is corrupt", row.space_id, cause)
    )
  )
})
