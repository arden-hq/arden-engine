import { Effect, Exit } from "effect"

import { parseIdempotencyRecord, parseTransaction } from "../domain/transaction.js"
import { normalizeRelativePath } from "../domain/model.js"
import { CorruptRepositoryError, RevisionStorageError, UnsafePathError } from "../domain/errors.js"
import type {
  MaintenanceIdempotencyRecord,
  MaintenanceMetadataStats,
  MaintenanceObjectEntry,
  MaintenanceObjectKind,
  MaintenanceProtectedTransaction,
  MaintenanceStorage,
  MaintenanceStorageError
} from "./maintenance.js"
import type { RevisionStorageShape, StorageError } from "./service.js"
import { compareCodePoints } from "@arden-hq/std/json"

const transactionDirectories = ["publish", "backups", "displaced", "rejected", "markers"] as const

const isHash = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length === 64 &&
  [...value].every((character) => "0123456789abcdef".includes(character))

const corrupt = (message: string): Effect.Effect<never, CorruptRepositoryError> =>
  Effect.fail(new CorruptRepositoryError({ message }))

const storageErrorMessage = (error: StorageError): string => `${error._tag}: ${error.message}`

const adaptStorageError = (error: StorageError): MaintenanceStorageError => {
  switch (error._tag) {
    case "RevisionStorageError":
      return error
    case "UnsafePathError":
      return error
    case "RevisionConflictError":
      return new RevisionStorageError({ message: storageErrorMessage(error), cause: error })
  }
}

const fromStorage = <A>(
  effect: Effect.Effect<A, StorageError>
): Effect.Effect<A, MaintenanceStorageError> => effect.pipe(Effect.mapError(adaptStorageError))

const objectFilename = (kind: MaintenanceObjectKind, id: string): string =>
  kind === "blob" ? id : `${id}.jsonl`

const objectPath = (kind: MaintenanceObjectKind, id: string): string =>
  `${kind === "commit" ? "commits" : `objects/${kind === "blob" ? "blobs" : "trees"}`}/${objectFilename(kind, id)}`

const checkedStat = (
  target: string,
  stat: { readonly size: number; readonly mtimeMillis: number | null } | null
): Effect.Effect<
  { readonly byteSize: number; readonly modifiedAtMillis: number },
  MaintenanceStorageError
> => {
  if (stat === null) return corrupt(`metadata entry disappeared: ${target}`)
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    return corrupt(`metadata entry has an invalid byte size: ${target}`)
  }
  if (stat.mtimeMillis === null || !Number.isSafeInteger(stat.mtimeMillis)) {
    return corrupt(`metadata entry has an invalid modification time: ${target}`)
  }
  return Effect.succeed({ byteSize: stat.size, modifiedAtMillis: stat.mtimeMillis })
}

const metadataBytes = Effect.fn("maintenanceAdapter.metadataBytes")(function* (
  storage: RevisionStorageShape,
  target: string
): Effect.fn.Return<number, MaintenanceStorageError> {
  const listed = yield* Effect.exit(fromStorage(storage.listMetadata(target)))
  if (Exit.isSuccess(listed)) {
    let total = 0
    for (const name of [...listed.value].sort(compareCodePoints)) {
      total += yield* metadataBytes(storage, `${target}/${name}`)
    }
    return total
  }
  const content = yield* fromStorage(storage.readMetadata(target, true))
  if (content === null) return yield* corrupt(`metadata entry disappeared: ${target}`)
  const stat = yield* fromStorage(storage.metadataStat(target))
  const measured = yield* checkedStat(target, stat)
  if (measured.byteSize !== content.length) {
    return yield* corrupt(`metadata entry changed during accounting: ${target}`)
  }
  return measured.byteSize
})

const optionalMetadataBytes = Effect.fn("maintenanceAdapter.optionalMetadataBytes")(function* (
  storage: RevisionStorageShape,
  target: string
): Effect.fn.Return<number | null, MaintenanceStorageError> {
  if (!(yield* fromStorage(storage.metadataExists(target)))) return null
  return yield* metadataBytes(storage, target)
})

const readProtectedTransaction = Effect.fn("maintenanceAdapter.readProtectedTransaction")(
  function* (
    storage: RevisionStorageShape,
    parent: "transactions" | "conflicts",
    transactionId: string
  ): Effect.fn.Return<MaintenanceProtectedTransaction | null, MaintenanceStorageError> {
    const prefix = `${parent}/${transactionId}`
    const prepared = yield* fromStorage(storage.readMetadata(`${prefix}/PREPARED`, true))
    if (prepared === null) return null
    if (prepared.length !== 0)
      return yield* corrupt(`transaction ${transactionId} PREPARED marker is not empty`)
    for (const directory of transactionDirectories) {
      yield* fromStorage(storage.listMetadata(`${prefix}/${directory}`))
    }
    const content = yield* fromStorage(storage.readMetadata(`${prefix}/manifest.jsonl`))
    if (content === null) return yield* corrupt(`transaction manifest is missing: ${transactionId}`)
    return {
      ...(yield* parseTransaction(transactionId, content)),
      conflicted: parent === "conflicts"
    }
  }
)

const listProtectedTransactions = Effect.fn("maintenanceAdapter.listProtectedTransactions")(
  function* (
    storage: RevisionStorageShape,
    parent: "transactions" | "conflicts"
  ): Effect.fn.Return<ReadonlyArray<MaintenanceProtectedTransaction>, MaintenanceStorageError> {
    const names = yield* fromStorage(storage.listMetadata(parent))
    const output: MaintenanceProtectedTransaction[] = []
    for (const name of [...names].sort(compareCodePoints)) {
      if (!isHash(name)) return yield* corrupt(`invalid ${parent} transaction directory: ${name}`)
      const transaction = yield* readProtectedTransaction(storage, parent, name)
      if (transaction !== null) output.push(transaction)
    }
    return output
  }
)

/** Adapt the repository's low-level storage contract to maintenance operations. */
export const maintenanceStorageFromRevisionStorage = (
  storage: RevisionStorageShape
): MaintenanceStorage => {
  const listObjects = Effect.fn("maintenanceAdapter.listObjects")(function* (
    kind: MaintenanceObjectKind
  ): Effect.fn.Return<ReadonlyArray<MaintenanceObjectEntry>, MaintenanceStorageError> {
    const ids = yield* fromStorage(storage.listObjectIds(kind))
    const entries: MaintenanceObjectEntry[] = []
    for (const id of [...ids].sort(compareCodePoints)) {
      if (!isHash(id)) return yield* corrupt(`invalid ${kind} object identifier: ${id}`)
      const target = objectPath(kind, id)
      const measured = yield* checkedStat(target, yield* fromStorage(storage.metadataStat(target)))
      entries.push({ name: objectFilename(kind, id), ...measured })
    }
    return entries
  })

  const readObject = (
    kind: MaintenanceObjectKind,
    id: string
  ): Effect.Effect<Uint8Array, MaintenanceStorageError> => {
    if (!isHash(id))
      return Effect.fail(new UnsafePathError({ message: `${kind} identifier is invalid: ${id}` }))
    switch (kind) {
      case "blob":
        return fromStorage(storage.readBlob(id))
      case "tree":
        return fromStorage(storage.readTree(id))
      case "commit":
        return fromStorage(storage.readCommit(id))
    }
  }

  const listIdempotency = Effect.gen(function* () {
    const names = yield* fromStorage(storage.listMetadata("idempotency"))
    const output: MaintenanceIdempotencyRecord[] = []
    for (const name of [...names].sort(compareCodePoints)) {
      if (!name.endsWith(".jsonl")) return yield* corrupt(`invalid idempotency filename: ${name}`)
      const keyHash = name.slice(0, -".jsonl".length)
      if (!isHash(keyHash)) return yield* corrupt(`invalid idempotency filename: ${name}`)
      const content = yield* fromStorage(storage.readIdempotency(keyHash))
      if (content === null) return yield* corrupt(`idempotency record disappeared: ${keyHash}`)
      output.push(yield* parseIdempotencyRecord(content, keyHash))
    }
    return output
  })

  const listProtected = Effect.gen(function* () {
    const transactions = yield* listProtectedTransactions(storage, "transactions")
    const conflicts = yield* listProtectedTransactions(storage, "conflicts")
    return [...transactions, ...conflicts]
  })

  const metadataStats: Effect.Effect<MaintenanceMetadataStats, MaintenanceStorageError> =
    Effect.gen(function* () {
      const transactionBytes = yield* metadataBytes(storage, "transactions")
      const conflictBytes = yield* metadataBytes(storage, "conflicts")
      const idempotencyBytes = yield* metadataBytes(storage, "idempotency")
      const publicationBytes = yield* metadataBytes(storage, "published")
      const refBytes = yield* metadataBytes(storage, "refs")
      const lockBytes = yield* optionalMetadataBytes(storage, "repository.lock")
      return {
        transactionBytes,
        conflictBytes,
        idempotencyBytes,
        publicationBytes,
        refBytes,
        lockBytes
      }
    })

  return {
    readRef: fromStorage(storage.readRef),
    listObjects,
    readObject,
    readWorking: (path) =>
      normalizeRelativePath(path).pipe(
        Effect.flatMap((normalized) => fromStorage(storage.readWorking(normalized, true, true)))
      ),
    listPublished: fromStorage(storage.listPublished).pipe(
      Effect.flatMap(
        Effect.fn("maintenanceAdapter.listPublished.ids")(function* (ids) {
          const output = [] as Array<{ readonly commitId: string }>
          for (const id of [...ids].sort(compareCodePoints)) {
            if (!isHash(id)) return yield* corrupt(`invalid publication marker: ${id}`)
            output.push({ commitId: id })
          }
          return output
        })
      )
    ),
    listIdempotency,
    listProtectedTransactions: listProtected,
    metadataStats,
    removeObject: (kind, id) => {
      if (!isHash(id))
        return Effect.fail(new UnsafePathError({ message: `${kind} identifier is invalid: ${id}` }))
      return fromStorage(storage.removeObject(kind, id))
    }
  }
}
