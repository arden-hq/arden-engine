import { storeErrorFields } from "../errors.js"
import { Context, Effect, Schema } from "effect"
import type { JsonObject } from "../json.js"

export const WikiRenameApprovalStatusSchema = Schema.Literals([
  "pending",
  "applying",
  "accepted",
  "rejected"
] as const)

interface WikiRenameApprovalFields {
  readonly approvalId: string
  readonly pageId: string
  readonly plan: JsonObject
  readonly createdAt: string
  readonly commitId: string | null
  readonly resolution: string | null
}

/** An approval and the writer that asked for it, which an accepted rename commits as. Only an
 *  approval closed before writers were kept has none. */
export type WikiRenameApprovalRecord = WikiRenameApprovalFields &
  (
    | { readonly status: "pending" | "applying"; readonly writer: JsonObject }
    | { readonly status: "accepted" | "rejected"; readonly writer: JsonObject | undefined }
  )

export interface CreateWikiRenameApprovalInput {
  readonly approvalId: string
  readonly pageId: string
  readonly plan: JsonObject
  readonly writer: JsonObject
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
