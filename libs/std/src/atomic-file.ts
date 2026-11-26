import { randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { chmod, open, rename, rm } from "node:fs/promises"
import path from "node:path"
import { onWindows } from "./process.js"

export interface AtomicWriteOptions {
  readonly mode?: number
}

const temporaryPathFor = (target: string): string =>
  path.join(path.dirname(target), `.${path.basename(target)}-${randomUUID()}.tmp`)

const SYNCS_DIRECTORIES = !onWindows

export const writeAtomic = async (
  target: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<void> => {
  const mode = options.mode ?? 0o600
  const directory = path.dirname(target)
  const temporary = temporaryPathFor(target)
  try {
    const handle = await open(temporary, "wx", mode)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
    if (SYNCS_DIRECTORIES) {
      await chmod(target, mode)
      const folder = await open(directory, "r")
      try {
        await folder.sync()
      } finally {
        await folder.close()
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export const writeAtomicSync = (
  target: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {}
): void => {
  const mode = options.mode ?? 0o600
  const directory = path.dirname(target)
  const temporary = temporaryPathFor(target)
  try {
    const file = openSync(temporary, "wx", mode)
    try {
      writeFileSync(file, content)
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(temporary, target)
    if (SYNCS_DIRECTORIES) {
      chmodSync(target, mode)
      const folder = openSync(directory, "r")
      try {
        fsyncSync(folder)
      } finally {
        closeSync(folder)
      }
    }
  } finally {
    rmSync(temporary, { force: true })
  }
}
