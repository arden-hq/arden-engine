import type { RevisionError } from "@arden-hq/revisions/effect"
import { Schema } from "effect"

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
  "rename"
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

export const mapRevisionError =
  (operation: WikiOperation, pageId?: string) =>
  (cause: RevisionError): WikiError => {
    const options = {
      ...(pageId === undefined ? {} : { pageId }),
      cause
    }
    switch (cause._tag) {
      case "RevisionConflictError":
        return wikiError(operation, "conflict", cause.message, options)
      case "CorruptRepositoryError":
        return wikiError(operation, "corrupt", cause.message, options)
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
