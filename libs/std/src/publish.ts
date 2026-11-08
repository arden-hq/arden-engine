import { randomUUID } from "node:crypto"
import { link, open, rm } from "node:fs/promises"
import path from "node:path"

/**
 * Writes `content` to `target` once: the bytes go to a fsynced sibling file and
 * are linked into place, so a reader sees all of them or none, and a file that
 * is already there is never replaced. True when this call published; false
 * when `target` already existed (the caller decides whether that is fine).
 */
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
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "EEXIST"
      ) {
        return false
      }
      throw cause
    }
  } finally {
    await rm(temporary, { force: true })
  }
}
