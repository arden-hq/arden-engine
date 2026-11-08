import { DateTime, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { JsonObjectSchema } from "../json.js"
import {
  WikiRenameApprovalStatusSchema,
  WikiRenameStore,
  WikiRenameStoreError,
  type CreateWikiRenameApprovalInput,
  type WikiRenameApprovalRecord,
  type WikiRenameStoreOperation
} from "../wiki/rename-store.js"
import { decodeJson, decodeWith, encodeJson } from "./json.js"
import type { PersistenceDeps } from "./deps.js"

interface ApprovalRow {
  readonly approval_id: string
  readonly page_id: string
  readonly plan_json: string
  readonly status: string
  readonly created_at: string
  readonly commit_id: string | null
  readonly resolution: string | null
}

const ApprovalRowSchema = Schema.Struct({
  approval_id: Schema.NonEmptyString,
  page_id: Schema.NonEmptyString,
  plan_json: Schema.String,
  status: WikiRenameApprovalStatusSchema,
  created_at: Schema.NonEmptyString,
  commit_id: Schema.NullOr(Schema.NonEmptyString),
  resolution: Schema.NullOr(Schema.String)
})

const CreateInputSchema = Schema.Struct({
  approvalId: Schema.NonEmptyString,
  pageId: Schema.NonEmptyString,
  plan: JsonObjectSchema
})

const DecisionInputSchema = Schema.Struct({
  approvalId: Schema.NonEmptyString,
  resolution: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))))
})

const FinishInputSchema = Schema.Struct({
  approvalId: Schema.NonEmptyString,
  commitId: Schema.NonEmptyString
})

const columns = `approval_id, page_id, plan_json, status, created_at, commit_id, resolution`

const error = (
  operation: WikiRenameStoreOperation,
  reason: WikiRenameStoreError["reason"],
  message: string,
  fields: { readonly approvalId?: string; readonly pageId?: string; readonly cause?: unknown } = {}
): WikiRenameStoreError =>
  new WikiRenameStoreError({
    operation,
    reason,
    message,
    ...(fields.approvalId === undefined ? {} : { approvalId: fields.approvalId }),
    ...(fields.pageId === undefined ? {} : { pageId: fields.pageId }),
    ...(fields.cause === undefined ? {} : { cause: fields.cause })
  })

const mapStorage =
  (
    operation: WikiRenameStoreOperation,
    message: string,
    fields: { readonly approvalId?: string; readonly pageId?: string } = {}
  ) =>
  (cause: unknown): WikiRenameStoreError =>
    cause instanceof WikiRenameStoreError
      ? cause
      : error(operation, "storage", message, { ...fields, cause })

const invalidInput = (operation: WikiRenameStoreOperation, message: string) => (cause: unknown) =>
  error(operation, "invalid", message, { cause })

const decodeApproval = Effect.fn("SqliteWikiRenameStore.decodeApproval")(function* (
  value: ApprovalRow,
  operation: WikiRenameStoreOperation
): Effect.fn.Return<WikiRenameApprovalRecord, WikiRenameStoreError> {
  const row = yield* Schema.decodeUnknownEffect(ApprovalRowSchema)(value, {
    onExcessProperty: "error"
  }).pipe(
    Effect.mapError((cause) =>
      error(operation, "corrupt", "Stored Wiki rename approval is corrupt", {
        approvalId: value.approval_id,
        pageId: value.page_id,
        cause
      })
    )
  )
  const plan = yield* decodeJson(JsonObjectSchema, row.plan_json).pipe(
    Effect.mapError((cause) =>
      error(operation, "corrupt", "Stored Wiki rename plan is corrupt", {
        approvalId: row.approval_id,
        pageId: row.page_id,
        cause
      })
    )
  )
  return {
    approvalId: row.approval_id,
    pageId: row.page_id,
    plan,
    status: row.status,
    createdAt: row.created_at,
    commitId: row.commit_id,
    resolution: row.resolution
  }
})

const load = Effect.fn("SqliteWikiRenameStore.load")(function* (
  sql: SqlClient.SqlClient,
  approvalId: string,
  operation: WikiRenameStoreOperation
): Effect.fn.Return<WikiRenameApprovalRecord | null, WikiRenameStoreError> {
  const rows = yield* sql
    .unsafe<ApprovalRow>(
      `SELECT ${columns} FROM wiki_rename_approvals WHERE approval_id = ? LIMIT 1`,
      [approvalId]
    )
    .pipe(
      Effect.mapError(mapStorage(operation, "Could not read Wiki rename approval", { approvalId }))
    )
  const row = rows[0]
  return row === undefined ? null : yield* decodeApproval(row, operation)
})

const requireApproval = Effect.fn("SqliteWikiRenameStore.requireApproval")(function* (
  sql: SqlClient.SqlClient,
  approvalId: string,
  operation: WikiRenameStoreOperation
): Effect.fn.Return<WikiRenameApprovalRecord, WikiRenameStoreError> {
  const approval = yield* load(sql, approvalId, operation)
  return approval === null
    ? yield* error(operation, "not_found", "Wiki rename approval was not found", { approvalId })
    : approval
})

const conflict = (
  operation: WikiRenameStoreOperation,
  approval: WikiRenameApprovalRecord
): WikiRenameStoreError =>
  error(operation, "conflict", `Wiki rename approval cannot transition from ${approval.status}`, {
    approvalId: approval.approvalId,
    pageId: approval.pageId
  })

export const makeWikiRenameStore = ({
  writer
}: Pick<PersistenceDeps, "writer">): WikiRenameStore["Service"] => {
  const sql = writer.sql
  const createOrGet = Effect.fn("SqliteWikiRenameStore.createOrGet")(function* (
    input: CreateWikiRenameApprovalInput
  ): Effect.fn.Return<WikiRenameApprovalRecord, WikiRenameStoreError> {
    const valid = yield* decodeWith(
      CreateInputSchema,
      input,
      invalidInput("create", "Invalid Wiki rename approval")
    )
    const planJson = yield* encodeJson(JsonObjectSchema, valid.plan).pipe(
      Effect.mapError((cause) =>
        error("create", "invalid", "Wiki rename plan cannot be encoded", {
          approvalId: valid.approvalId,
          pageId: valid.pageId,
          cause
        })
      )
    )
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const openRows = yield* sql
            .unsafe<ApprovalRow>(
              // oxlint-disable-next-line arden/restricted-owner -- an unsafe SQL string cannot embed a status fragment
              `SELECT ${columns}
         FROM wiki_rename_approvals
         WHERE page_id = ? AND status IN ('pending', 'applying')
         LIMIT 1`,
              [valid.pageId]
            )
            .pipe(
              Effect.mapError(
                mapStorage("create", "Could not inspect open Wiki rename approvals", {
                  approvalId: valid.approvalId,
                  pageId: valid.pageId
                })
              )
            )
          const open = openRows[0]
          if (open !== undefined) {
            if (open.plan_json !== planJson) {
              return yield* error(
                "create",
                "conflict",
                "A different Wiki rename is already open for this page",
                {
                  approvalId: open.approval_id,
                  pageId: valid.pageId
                }
              )
            }
            return yield* decodeApproval(open, "create")
          }

          const createdAt = DateTime.formatIso(yield* DateTime.now)
          const rows = yield* sql<ApprovalRow>`
        INSERT INTO wiki_rename_approvals (
          approval_id, page_id, plan_json, status, created_at,
          commit_id, resolution
        ) VALUES (
          ${valid.approvalId}, ${valid.pageId}, ${planJson}, 'pending', ${createdAt},
          NULL, NULL
        )
        RETURNING approval_id, page_id, plan_json, status, created_at, commit_id, resolution
      `.pipe(
            Effect.mapError(
              mapStorage("create", "Could not create Wiki rename approval", {
                approvalId: valid.approvalId,
                pageId: valid.pageId
              })
            )
          )
          const row = rows[0]
          if (row === undefined) {
            return yield* error(
              "create",
              "storage",
              "Created Wiki rename approval could not be read",
              {
                approvalId: valid.approvalId,
                pageId: valid.pageId
              }
            )
          }
          return yield* decodeApproval(row, "create")
        })
      )
      .pipe(
        Effect.mapError(
          mapStorage("create", "Could not complete Wiki rename approval creation", {
            approvalId: valid.approvalId,
            pageId: valid.pageId
          })
        )
      )
  })

  const get = Effect.fn("SqliteWikiRenameStore.get")(function* (
    approvalId: string
  ): Effect.fn.Return<WikiRenameApprovalRecord | null, WikiRenameStoreError> {
    const valid = yield* decodeWith(
      Schema.NonEmptyString,
      approvalId,
      invalidInput("get", "Invalid Wiki rename approval id")
    )
    return yield* load(sql, valid, "get")
  })

  const listOpen = Effect.fn("SqliteWikiRenameStore.listOpen")(function* (): Effect.fn.Return<
    ReadonlyArray<WikiRenameApprovalRecord>,
    WikiRenameStoreError
  > {
    const rows = yield* sql
      .unsafe<ApprovalRow>(
        // oxlint-disable-next-line arden/restricted-owner -- an unsafe SQL string cannot embed a status fragment
        `SELECT ${columns}
       FROM wiki_rename_approvals
       WHERE status IN ('pending', 'applying')
       ORDER BY created_at, approval_id
       LIMIT 100`
      )
      .pipe(Effect.mapError(mapStorage("list", "Could not list open Wiki rename approvals")))
    return yield* Effect.forEach(rows, (row) => decodeApproval(row, "list"))
  })

  const beginApply = Effect.fn("SqliteWikiRenameStore.beginApply")(function* (
    approvalId: string
  ): Effect.fn.Return<WikiRenameApprovalRecord, WikiRenameStoreError> {
    const valid = yield* decodeWith(
      Schema.NonEmptyString,
      approvalId,
      invalidInput("begin_apply", "Invalid Wiki rename approval id")
    )
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<ApprovalRow>`
        UPDATE wiki_rename_approvals
        SET status = 'applying', resolution = NULL
        WHERE approval_id = ${valid} AND status = 'pending'
        RETURNING approval_id, page_id, plan_json, status, created_at, commit_id, resolution
      `.pipe(
            Effect.mapError(
              mapStorage("begin_apply", "Could not begin Wiki rename approval", {
                approvalId: valid
              })
            )
          )
          const row = rows[0]
          if (row !== undefined) return yield* decodeApproval(row, "begin_apply")
          return yield* requireApproval(sql, valid, "begin_apply")
        })
      )
      .pipe(
        Effect.mapError(
          mapStorage("begin_apply", "Could not complete Wiki rename approval claim", {
            approvalId: valid
          })
        )
      )
  })

  const finishApply = Effect.fn("SqliteWikiRenameStore.finishApply")(function* (
    approvalId: string,
    commitId: string
  ): Effect.fn.Return<WikiRenameApprovalRecord, WikiRenameStoreError> {
    const valid = yield* decodeWith(
      FinishInputSchema,
      { approvalId, commitId },
      invalidInput("finish_apply", "Invalid Wiki rename completion")
    )
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<ApprovalRow>`
        UPDATE wiki_rename_approvals
        SET status = 'accepted', commit_id = ${valid.commitId}, resolution = NULL
        WHERE approval_id = ${valid.approvalId} AND status = 'applying'
        RETURNING approval_id, page_id, plan_json, status, created_at, commit_id, resolution
      `.pipe(
            Effect.mapError(
              mapStorage("finish_apply", "Could not finish Wiki rename approval", {
                approvalId: valid.approvalId
              })
            )
          )
          const row = rows[0]
          if (row !== undefined) return yield* decodeApproval(row, "finish_apply")
          const current = yield* requireApproval(sql, valid.approvalId, "finish_apply")
          return current.status === "accepted" && current.commitId === valid.commitId
            ? current
            : yield* conflict("finish_apply", current)
        })
      )
      .pipe(
        Effect.mapError(
          mapStorage("finish_apply", "Could not complete Wiki rename approval", {
            approvalId: valid.approvalId
          })
        )
      )
  })

  const releaseApply = Effect.fn("SqliteWikiRenameStore.releaseApply")(function* (
    approvalId: string,
    resolution?: string | null
  ): Effect.fn.Return<WikiRenameApprovalRecord, WikiRenameStoreError> {
    const valid = yield* decodeWith(
      DecisionInputSchema,
      resolution === undefined ? { approvalId } : { approvalId, resolution },
      invalidInput("release_apply", "Invalid Wiki rename release")
    )
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<ApprovalRow>`
        UPDATE wiki_rename_approvals
        SET status = 'pending', resolution = ${valid.resolution ?? null}
        WHERE approval_id = ${valid.approvalId} AND status = 'applying'
        RETURNING approval_id, page_id, plan_json, status, created_at, commit_id, resolution
      `.pipe(
            Effect.mapError(
              mapStorage("release_apply", "Could not release Wiki rename approval", {
                approvalId: valid.approvalId
              })
            )
          )
          const row = rows[0]
          if (row !== undefined) return yield* decodeApproval(row, "release_apply")
          const current = yield* requireApproval(sql, valid.approvalId, "release_apply")
          return current.status === "pending" ? current : yield* conflict("release_apply", current)
        })
      )
      .pipe(
        Effect.mapError(
          mapStorage("release_apply", "Could not complete Wiki rename approval release", {
            approvalId: valid.approvalId
          })
        )
      )
  })

  const reject = Effect.fn("SqliteWikiRenameStore.reject")(function* (
    approvalId: string,
    resolution?: string | null
  ): Effect.fn.Return<WikiRenameApprovalRecord, WikiRenameStoreError> {
    const valid = yield* decodeWith(
      DecisionInputSchema,
      resolution === undefined ? { approvalId } : { approvalId, resolution },
      invalidInput("reject", "Invalid Wiki rename rejection")
    )
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const rows = yield* sql<ApprovalRow>`
        UPDATE wiki_rename_approvals
        SET status = 'rejected', resolution = ${valid.resolution ?? null}
        WHERE approval_id = ${valid.approvalId} AND status = 'pending'
        RETURNING approval_id, page_id, plan_json, status, created_at, commit_id, resolution
      `.pipe(
            Effect.mapError(
              mapStorage("reject", "Could not reject Wiki rename approval", {
                approvalId: valid.approvalId
              })
            )
          )
          const row = rows[0]
          if (row !== undefined) return yield* decodeApproval(row, "reject")
          return yield* requireApproval(sql, valid.approvalId, "reject")
        })
      )
      .pipe(
        Effect.mapError(
          mapStorage("reject", "Could not complete Wiki rename approval rejection", {
            approvalId: valid.approvalId
          })
        )
      )
  })

  return WikiRenameStore.of({
    createOrGet,
    get,
    listOpen,
    beginApply,
    finishApply,
    releaseApply,
    reject
  })
}
