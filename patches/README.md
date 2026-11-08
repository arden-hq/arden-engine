# Dependency patches

Bun applies each patch in this folder. `package.json` and `bun.lock` name the patched version.

## `effect@4.0.0-beta.107.patch`

Effect SQL must not run `ROLLBACK` when `BEGIN` or `SAVEPOINT` failed. The patch keeps the first failure of a transaction start. Connection cleanup still runs. A transaction that started keeps the normal commit and rollback behavior.

The patch changes both the published JavaScript and the TypeScript source.

Remove it when an Effect upgrade includes the fix.
