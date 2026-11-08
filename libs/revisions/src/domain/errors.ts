import { Schema } from "effect"

/** A revision request violates a current resource or repository precondition. */
export class RevisionConflictError extends Schema.TaggedError<RevisionConflictError>()(
  "RevisionConflictError",
  {
    message: Schema.String
  }
) {}

/** An idempotency key was reused for a different request. */
export class IdempotencyConflictError extends Schema.TaggedError<IdempotencyConflictError>()(
  "IdempotencyConflictError",
  { message: Schema.String }
) {}

/** Persisted revision metadata or an immutable object is invalid. */
export class CorruptRepositoryError extends Schema.TaggedError<CorruptRepositoryError>()(
  "CorruptRepositoryError",
  {
    message: Schema.String
  }
) {}

/** A content operation exceeds its caller-declared byte bound. */
export class RevisionContentLimitError extends Schema.TaggedError<RevisionContentLimitError>()(
  "RevisionContentLimitError",
  {
    actualBytes: Schema.Int,
    limitBytes: Schema.Int,
    message: Schema.String
  }
) {}

/** A managed or metadata path is not a normalized relative path. */
export class UnsafePathError extends Schema.TaggedError<UnsafePathError>()("UnsafePathError", {
  message: Schema.String
}) {}

/** A change set does not produce a new repository state. */
export class NoChangesError extends Schema.TaggedError<NoChangesError>()("NoChangesError", {
  message: Schema.String
}) {}

/** An input record cannot be represented by the revisions v2 contract. */
export class InvalidRevisionInputError extends Schema.TaggedError<InvalidRevisionInputError>()(
  "InvalidRevisionInputError",
  { message: Schema.String }
) {}

/** A filesystem operation could not be completed by the repository adapter. */
export class RevisionStorageError extends Schema.TaggedError<RevisionStorageError>()(
  "RevisionStorageError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

/** The repository's scope closed; the service handle outlived its layer. */
export class RepositoryClosedError extends Schema.TaggedError<RepositoryClosedError>()(
  "RepositoryClosedError",
  { message: Schema.String }
) {}

export type RevisionError =
  | RevisionConflictError
  | IdempotencyConflictError
  | CorruptRepositoryError
  | RevisionContentLimitError
  | UnsafePathError
  | NoChangesError
  | InvalidRevisionInputError
  | RevisionStorageError
  | RepositoryClosedError
