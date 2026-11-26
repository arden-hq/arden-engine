import { Schema } from "effect"

export class RevisionConflictError extends Schema.TaggedError<RevisionConflictError>()(
  "RevisionConflictError",
  {
    message: Schema.String
  }
) {}

export class WorkingFileChangedError extends Schema.TaggedError<WorkingFileChangedError>()(
  "WorkingFileChangedError",
  { path: Schema.String, message: Schema.String }
) {}

export class IdempotencyConflictError extends Schema.TaggedError<IdempotencyConflictError>()(
  "IdempotencyConflictError",
  { message: Schema.String }
) {}

export class CorruptRepositoryError extends Schema.TaggedError<CorruptRepositoryError>()(
  "CorruptRepositoryError",
  {
    message: Schema.String
  }
) {}

export class RevisionContentLimitError extends Schema.TaggedError<RevisionContentLimitError>()(
  "RevisionContentLimitError",
  {
    actualBytes: Schema.Int,
    limitBytes: Schema.Int,
    message: Schema.String
  }
) {}

export class UnsafePathError extends Schema.TaggedError<UnsafePathError>()("UnsafePathError", {
  message: Schema.String
}) {}

export class NoChangesError extends Schema.TaggedError<NoChangesError>()("NoChangesError", {
  message: Schema.String
}) {}

export class InvalidRevisionInputError extends Schema.TaggedError<InvalidRevisionInputError>()(
  "InvalidRevisionInputError",
  { message: Schema.String }
) {}

export class RevisionStorageError extends Schema.TaggedError<RevisionStorageError>()(
  "RevisionStorageError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class RepositoryClosedError extends Schema.TaggedError<RepositoryClosedError>()(
  "RepositoryClosedError",
  { message: Schema.String }
) {}

export type RevisionError =
  | RevisionConflictError
  | WorkingFileChangedError
  | IdempotencyConflictError
  | CorruptRepositoryError
  | RevisionContentLimitError
  | UnsafePathError
  | NoChangesError
  | InvalidRevisionInputError
  | RevisionStorageError
  | RepositoryClosedError
