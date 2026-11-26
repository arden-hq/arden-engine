import { Match, Schema } from "effect"

import type { WikiCommitError } from "./commit-write-types.js"

export const WIKI_OPERATION = {
  open: "open",
  observe: "observe",
  create: "create",
  list: "list",
  read: "read",
  update: "update",
  archive: "archive",
  merge: "merge",
  history: "history",
  restore: "restore",
  diff: "diff",
  links: "links",
  rename: "rename",
  forget: "forget"
} as const

const WikiOperationSchema = Schema.Literals(Object.values(WIKI_OPERATION))

export type WikiOperation = typeof WikiOperationSchema.Type

export class WikiPageFormatError extends Schema.TaggedError<WikiPageFormatError>()(
  "WikiPageFormatError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export const WIKI_ERROR_REASON = {
  invalid: "invalid",
  not_found: "not_found",
  conflict: "conflict",
  blocked: "blocked",
  closed: "closed",
  corrupt: "corrupt",
  storage: "storage"
} as const

export class WikiError extends Schema.TaggedError<WikiError>()("WikiError", {
  operation: WikiOperationSchema,
  reason: Schema.Literals(Object.values(WIKI_ERROR_REASON)),
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

const RULE_REASON: Readonly<
  Record<
    Extract<WikiCommitError, { readonly _tag: "WikiCommitRuleError" }>["rule"],
    | typeof WIKI_ERROR_REASON.invalid
    | typeof WIKI_ERROR_REASON.blocked
    | typeof WIKI_ERROR_REASON.conflict
  >
> = {
  names: WIKI_ERROR_REASON.conflict,
  aliases: WIKI_ERROR_REASON.invalid,
  size: WIKI_ERROR_REASON.invalid,
  retraction: WIKI_ERROR_REASON.invalid,
  records: WIKI_ERROR_REASON.blocked,
  retire: WIKI_ERROR_REASON.blocked,
  code_owned: WIKI_ERROR_REASON.blocked,
  space: WIKI_ERROR_REASON.blocked
}

export const mapRevisionError =
  (operation: WikiOperation, pageId?: string): ((cause: WikiCommitError) => WikiError) =>
  (cause: WikiCommitError): WikiError => {
    const options = {
      ...(pageId === undefined ? {} : { pageId }),
      cause
    }
    const invalid = (found: { readonly message: string }): WikiError =>
      wikiError(operation, WIKI_ERROR_REASON.invalid, found.message, options)
    return Match.valueTags(cause, {
      WikiError: (found) => new WikiError({ ...found, message: found.message, operation }),
      RevisionConflictError: (found) =>
        wikiError(operation, WIKI_ERROR_REASON.conflict, found.message, options),
      WorkingFileChangedError: (found) =>
        wikiError(
          operation,
          WIKI_ERROR_REASON.blocked,
          `${found.path} was changed outside Arden and Memory has not taken that change in. Nothing was saved.`,
          options
        ),
      CorruptRepositoryError: (found) =>
        wikiError(operation, WIKI_ERROR_REASON.corrupt, found.message, options),
      WikiCommitRuleError: (found) =>
        wikiError(operation, RULE_REASON[found.rule], found.message, options),
      InvalidRevisionInputError: invalid,
      NoChangesError: invalid,
      RevisionContentLimitError: invalid,
      UnsafePathError: invalid,
      RepositoryClosedError: (found) =>
        wikiError(operation, WIKI_ERROR_REASON.closed, found.message, options),
      RevisionStorageError: (found) =>
        wikiError(operation, WIKI_ERROR_REASON.storage, found.message, options),
      SpaceStoreError: () =>
        wikiError(
          operation,
          WIKI_ERROR_REASON.storage,
          "Could not check which pages Spaces own",
          options
        ),
      IdempotencyConflictError: () =>
        wikiError(operation, WIKI_ERROR_REASON.storage, "internal write identity conflict", options)
    })
  }
