import { storeErrorFields } from "../errors.js"
import { Context, Effect, Schema } from "effect"
import type { JsonObject } from "../json.js"

export const WikiRenameApprovalStatusSchema = Schema.Literals([
  "pending",
  "applying",
  "accepted",
  "rejected"
] as const)

type WikiRenameApprovalStatus = (typeof WikiRenameApprovalStatusSchema)["Type"]

export interface WikiRenameApprovalRecord {
  readonly approvalId: string
  readonly pageId: string
  readonly plan: JsonObject
  readonly status: WikiRenameApprovalStatus
  readonly createdAt: string
  readonly commitId: string | null
  readonly resolution: string | null
}

export interface CreateWikiRenameApprovalInput {
  readonly approvalId: string
  readonly pageId: string
  readonly plan: JsonObject
}

export type WikiRenameStoreOperation =
  | "create"
  | "get"
  | "list"
  | "begin_apply"
  | "finish_apply"
  | "release_apply"
  | "reject"

export class WikiRenameStoreError extends Schema.TaggedError<WikiRenameStoreError>()(
  "WikiRenameStoreError",
  {
    ...storeErrorFields({
      operations: [
        "create",
        "get",
        "list",
        "begin_apply",
        "finish_apply",
        "release_apply",
        "reject"
      ],
      reasons: ["invalid", "not_found", "conflict", "corrupt", "storage"]
    }),
    approvalId: Schema.optionalKey(Schema.NonEmptyString),
    pageId: Schema.optionalKey(Schema.NonEmptyString)
  }
) {}

export class WikiRenameStore extends Context.Service<
  WikiRenameStore,
  {
    readonly createOrGet: (
      input: CreateWikiRenameApprovalInput
    ) => Effect.Effect<WikiRenameApprovalRecord, WikiRenameStoreError>
    readonly get: (
      approvalId: string
    ) => Effect.Effect<WikiRenameApprovalRecord | null, WikiRenameStoreError>
    readonly listOpen: () => Effect.Effect<
      ReadonlyArray<WikiRenameApprovalRecord>,
      WikiRenameStoreError
    >
    readonly beginApply: (
      approvalId: string
    ) => Effect.Effect<WikiRenameApprovalRecord, WikiRenameStoreError>
    readonly finishApply: (
      approvalId: string,
      commitId: string
    ) => Effect.Effect<WikiRenameApprovalRecord, WikiRenameStoreError>
    readonly releaseApply: (
      approvalId: string,
      resolution?: string | null
    ) => Effect.Effect<WikiRenameApprovalRecord, WikiRenameStoreError>
    readonly reject: (
      approvalId: string,
      resolution?: string | null
    ) => Effect.Effect<WikiRenameApprovalRecord, WikiRenameStoreError>
  }
>()("@arden-hq/server/persistence/wiki/WikiRenameStore") {}
