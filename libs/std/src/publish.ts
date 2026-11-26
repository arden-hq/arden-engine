import { randomUUID } from "node:crypto"
import { link, open, rm } from "node:fs/promises"
import path from "node:path"
import { ERRNO, isErrnoCode } from "./errors.js"

export const publishNoReplace = async (
  target: string,
  content: string | Uint8Array,
  options: { readonly mode?: number } = {}
): Promise<boolean> => {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, "wx", options.mode ?? 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(temporary, target)
      return true
    } catch (cause) {
      if (isErrnoCode(cause, ERRNO.EEXIST)) return false
      throw cause
    }
  } finally {
    await rm(temporary, { force: true })
  }
}
