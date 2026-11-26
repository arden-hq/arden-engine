export { ManagedFileRepository } from "../repository/service.js"
export type {
  ManagedFileRepositoryOptions,
  ManagedFileRepositoryShape,
  RepositoryError,
  RepositoryOpenPhase
} from "../repository/service-types.js"
export { UNTRACKED_FILE_KIND, WORKING_FILE_CHANGE_KIND } from "../repository/working.js"
export type {
  AdoptableWorkingChange,
  UntrackedFile,
  WorkingFileChange,
  WorkingTreeStatus,
  WorkingTreeStatusOptions
} from "../repository/working.js"
export type { AdoptWorkingChangeOptions, CommitInput, CommitResult } from "../repository/commit.js"
export { managedFileRepositoryNodeLayer } from "../storage/node.js"
export {
  CorruptRepositoryError,
  IdempotencyConflictError,
  InvalidRevisionInputError,
  NoChangesError,
  RepositoryClosedError,
  RevisionConflictError,
  WorkingFileChangedError,
  RevisionContentLimitError,
  RevisionStorageError,
  UnsafePathError
} from "../domain/errors.js"
export type { RevisionError } from "../domain/errors.js"
export { CHANGE_ACTION, isDotSegment, PATH_SEGMENT, RESOURCE_STATE } from "../domain/model.js"
export type {
  ChangeAction,
  Commit,
  ResourceChange,
  ResourceState,
  ResourceVersion
} from "../domain/model.js"
export type { ResourceDiff, ResourceDiffPage } from "../domain/query.js"
export type {
  CollectionReport,
  IntegrityReport,
  StorageReport
} from "../storage/maintenance-types.js"
