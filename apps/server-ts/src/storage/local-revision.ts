import { randomUUID } from "node:crypto"
import path from "node:path"
import { chmod, open, readFile, rename, rm, stat } from "node:fs/promises"
import { isErrnoCode } from "../fs/private-store.js"
import { sha256Hex } from "@arden-hq/std/hash"

export class LocalRevisionConflict extends Error {
  constructor() {
    super("The file changed after it was reviewed")
    this.name = "LocalRevisionConflict"
  }
}

const revisionOrAbsent = async (target: string): Promise<string> => {
  try {
    return sha256Hex(await readFile(target))
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) return "absent"
    throw cause
  }
}

export const atomicCompareAndSwap = async (
  target: string,
  content: string,
  expectedRevision: string
): Promise<{ readonly revision: string; readonly bytes: number }> => {
  if ((await revisionOrAbsent(target)) !== expectedRevision) throw new LocalRevisionConflict()
  const encoded = Buffer.from(content, "utf8")
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.arden-${randomUUID()}.tmp`
  )
  let mode: number | null = null
  try {
    mode = (await stat(target)).mode & 0o777
  } catch (cause) {
    if (!isErrnoCode(cause, "ENOENT")) throw cause
  }
  try {
    const handle = await open(temporary, "wx", mode ?? 0o666)
    try {
      await handle.writeFile(encoded)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if ((await revisionOrAbsent(target)) !== expectedRevision) throw new LocalRevisionConflict()
    await rename(temporary, target)
    if (mode !== null) await chmod(target, mode)
  } finally {
    await rm(temporary, { force: true })
  }
  return { revision: sha256Hex(encoded), bytes: encoded.byteLength }
}
