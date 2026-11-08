export { ManagedFileRepository } from "../repository/service.js"
export type {
  AdoptWorkingChangesOptions,
  CommitInput,
  ManagedFileRepositoryOptions,
  ManagedFileRepositoryShape,
  RepositoryError,
  RepositoryOpenPhase,
  WorkingTreeChangesPreview
} from "../repository/service.js"
export type { CommitResult } from "../repository/commit.js"
export { managedFileRepositoryNodeLayer } from "../storage/node.js"
export {
  CorruptRepositoryError,
  IdempotencyConflictError,
  InvalidRevisionInputError,
  NoChangesError,
  RepositoryClosedError,
  RevisionConflictError,
  RevisionContentLimitError,
  RevisionStorageError,
  UnsafePathError
} from "../domain/errors.js"
export type { RevisionError } from "../domain/errors.js"
export type { Commit, ResourceChange, ResourceVersion, WorkingTreeChange } from "../domain/model.js"
export type { ResourceDiff, ResourceDiffPage } from "../domain/query.js"
export type { CollectionReport, IntegrityReport, StorageReport } from "../storage/maintenance.js"
