# `@arden-hq/revisions`

Durable, content-addressed history for files that an application manages. `@arden-hq/server` uses it.

The files stay in a normal working directory. The library keeps immutable history, stable resource IDs, atomic changes, diffs and recovery. All managed writes go through the repository.

It is smaller than Git. It has one linear history. It has no branches, remotes, staging or merges.

The one entry is `@arden-hq/revisions/effect`. It exports the `ManagedFileRepository` Effect service, `managedFileRepositoryNodeLayer` and the tagged errors. Effect is a peer dependency.

## Example

```ts
import { Effect } from "effect"
import { ManagedFileRepository, managedFileRepositoryNodeLayer } from "@arden-hq/revisions/effect"

const program = Effect.gen(function* () {
  const revisions = yield* ManagedFileRepository
  yield* revisions.commit({
    actor: "editor",
    origin: "desktop",
    reason: "Create the guide",
    expectedHead: null,
    enforceExpectedHead: true,
    operations: [
      { _tag: "Create", resourceId: "guide", path: "docs/guide.md", content: new TextEncoder().encode("# Guide\n") }
    ]
  })
  return yield* revisions.read("guide")
})

Effect.runPromise(program.pipe(Effect.provide(managedFileRepositoryNodeLayer({ workingRoot: "./content" }))))
```

`resourceId` is the stable identity. `path` can change. Content is bytes. History lives in `<workingRoot>/.managed-history`.

## Rules

- All operations in one `commit` apply together or not at all. The operations are `Create`, `Update`, `Move`, `Archive` and `Restore`.
- Every operation except `Create` names the `expectedVersion` it replaces. A stale version fails with `RevisionConflictError`.
- `expectedHead` guards the whole repository. Leave it out for no check.
- Every commit has an `idempotencyKey`. The same key with the same request returns the first commit with `replayed: true`. The same key with a different request fails with `IdempotencyConflictError`.
- `previewWorkingChanges` and `adoptWorkingChanges` turn edits made outside the library into one guarded revision. Adoption fails if anything changed after the preview.
- Reads use the current revision. Pass `at` to read an older one.
- `listResources` and `findByPath` hide archived resources unless you pass `includeArchived`.

## Service members

| Task | Members |
| --- | --- |
| Current state | `currentRevision`, `get`, `findByPath`, `listResources` |
| Content | `read`, `readVersion`, `contentSize` |
| Writes | `commit`, `idempotencyReceipt`, `finalizeIdempotencyReceipt` |
| External edits | `previewWorkingChanges`, `adoptWorkingChanges` |
| History | `history`, `inspectCommit`, `isReachable`, `restoreFromCommit` |
| Diffs | `diff`, `diffPage`, `diffVersionsPage` |
| Maintenance | `integrityReport`, `storageReport`, `collect` |

## Errors

Every error has a `_tag`. The union is `RevisionError`. The tags are `RevisionConflictError`, `UnsafePathError`, `InvalidRevisionInputError`, `NoChangesError`, `RevisionContentLimitError`, `IdempotencyConflictError`, `CorruptRepositoryError`, `RevisionStorageError` and `RepositoryClosedError`.

A write installs content, working files and the new revision as one recoverable step. Opening the repository finishes safe prepared steps. A rollback conflict goes to `conflicts/` for inspection. Use `integrityReport` for a full check. `currentRevision` and `isReachable` do not scan objects.

## Limits

- Use it in Node, Bun and Electron main or utility processes. Do not use it in a browser or a renderer.
- Managed paths are relative POSIX paths. Unsafe symlinks and hardlinks are rejected.
- The storage root must be a trusted folder.
- Processes share the repository through a heartbeat lock. A second process that holds the lock makes a write fail with `RevisionConflictError`.

## Layout

- `src/domain/` holds the model, format, validation and queries.
- `src/repository/` holds the service and its transactions.
- `src/storage/` holds the filesystem adapter, recovery and maintenance.
- `src/effect/` holds the package entry.

## Build

```bash
bun run build
bun run typecheck
bun run test
```
