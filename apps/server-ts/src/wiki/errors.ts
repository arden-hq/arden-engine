import { Schema } from "effect"

import type { WikiCommitError } from "./commit.js"

const WikiOperationSchema = Schema.Literals([
  "open",
  "observe",
  "create",
  "list",
  "read",
  "update",
  "archive",
  "merge",
  "history",
  "restore",
  "diff",
  "links",
  "rename",
  "forget"
] as const)

export type WikiOperation = typeof WikiOperationSchema.Type

export class WikiPageFormatError extends Schema.TaggedError<WikiPageFormatError>()(
  "WikiPageFormatError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class WikiError extends Schema.TaggedError<WikiError>()("WikiError", {
  operation: WikiOperationSchema,
  reason: Schema.Literals([
    "invalid",
    "not_found",
    "conflict",
    "blocked",
    "closed",
    "corrupt",
    "storage"
  ] as const),
  message: Schema.String,
  pageId: Schema.optionalKey(Schema.NonEmptyString),
  currentContent: Schema.optionalKey(Schema.String),
  currentVersion: Schema.optionalKey(Schema.NonEmptyString),
  currentHead: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export const wikiError = (
  operation: WikiOperation,
  reason: WikiError["reason"],
  message: string,
  options?: {
    readonly pageId?: string
    readonly currentContent?: string
    readonly currentVersion?: string
    readonly currentHead?: string | null
    readonly cause?: unknown
  }
): WikiError =>
  new WikiError({
    operation,
    reason,
    message,
    ...(options?.pageId === undefined ? {} : { pageId: options.pageId }),
    ...(options?.currentContent === undefined ? {} : { currentContent: options.currentContent }),
    ...(options?.currentVersion === undefined ? {} : { currentVersion: options.currentVersion }),
    ...(options?.currentHead === undefined ? {} : { currentHead: options.currentHead }),
    ...(options?.cause === undefined ? {} : { cause: options.cause })
  })

/** A refused write is `invalid` when what was written breaks a rule, `blocked` when this writer
 *  may not make it. */
const ruleReason = (
  rule: Extract<WikiCommitError, { readonly _tag: "WikiCommitRuleError" }>["rule"]
): "invalid" | "blocked" => {
  switch (rule) {
    case "aliases":
    case "size":
    case "retraction":
      return "invalid"
    case "records":
    case "retire":
    case "code_owned":
      return "blocked"
  }
}

export const mapRevisionError =
  (operation: WikiOperation, pageId?: string) =>
  (cause: WikiCommitError): WikiError => {
    const options = {
      ...(pageId === undefined ? {} : { pageId }),
      cause
    }
    switch (cause._tag) {
      case "RevisionConflictError":
        return wikiError(operation, "conflict", cause.message, options)
      case "WorkingFileChangedError":
        return wikiError(
          operation,
          "blocked",
          `${cause.path} was changed outside Arden and Memory has not taken that change in. Nothing was saved.`,
          options
        )
      case "CorruptRepositoryError":
        return wikiError(operation, "corrupt", cause.message, options)
      case "WikiCommitRuleError":
        return wikiError(operation, ruleReason(cause.rule), cause.message, options)
      case "InvalidRevisionInputError":
      case "NoChangesError":
      case "RevisionContentLimitError":
      case "UnsafePathError":
        return wikiError(operation, "invalid", cause.message, options)
      case "RepositoryClosedError":
        return wikiError(operation, "closed", cause.message, options)
      case "RevisionStorageError":
        return wikiError(operation, "storage", cause.message, options)
      case "IdempotencyConflictError":
        return wikiError(operation, "storage", "internal write identity conflict", options)
    }
  }
