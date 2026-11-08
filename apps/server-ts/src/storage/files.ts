import type { StorageFile, StorageFiles } from "@arden-hq/protocol/storage"
import { Effect } from "effect"
import { join } from "node:path"
import { filesystem, scanStorageUnitsUnsafe, type StorageUnit } from "./inventory.js"
import type { StorageError } from "./errors.js"
import { classifyStorageRootEntry } from "./catalog.js"

const management = (unit: StorageUnit, databaseName: string | null): StorageFile["management"] => {
  const known = unit.members
    .map((member) => classifyStorageRootEntry(member.name, databaseName))
    .find((entry) => entry.kind === "known")
  if (known !== undefined && known.kind === "known") {
    return { action: "inspect", reason: known.lifecycle }
  }
  return {
    action: "inspect",
    reason: unit.members.some((member) => member.kind === "directory")
      ? "Unknown folder. Inspect in Finder; Arden cannot establish ownership or safe deletion."
      : "Unknown file. Inspect in Finder; Arden cannot establish ownership or safe deletion."
  }
}

export interface StorageFileInventory {
  readonly list: () => Effect.Effect<StorageFiles, StorageError>
}

export const makeStorageFiles = (options: {
  root: string
  databaseName: string | null
}): StorageFileInventory => {
  const scan = Effect.fn("StorageFiles.scan")(function* () {
    const root = options.root
    const units = yield* filesystem("overview", "Could not inspect storage files", () =>
      scanStorageUnitsUnsafe(root)
    )
    return { root, units }
  })
  const list = Effect.fn("StorageFiles.list")(function* (): Effect.fn.Return<
    StorageFiles,
    StorageError
  > {
    const { root, units } = yield* scan()
    return {
      rootPath: root,
      files: units
        .map((unit): StorageFile => ({
          id: unit.id,
          name: unit.name,
          path: join(root, unit.name),
          sizeBytes: unit.sizeBytes,
          memberCount: unit.members.length,
          kind: unit.members.some((member) => member.kind === "directory") ? "directory" : "file",
          management: management(unit, options.databaseName)
        }))
        .sort(
          (left, right) => right.sizeBytes - left.sizeBytes || left.name.localeCompare(right.name)
        )
    }
  })
  return { list }
}
