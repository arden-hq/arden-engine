import { constants } from "node:fs"
import { chmod, lstat, mkdir, open } from "node:fs/promises"
import { Predicate } from "effect"

export type PrivateFileViolation = "not_regular" | "too_large" | "not_directory"

export class PrivateFileError extends Error {
  readonly reason: PrivateFileViolation

  constructor(reason: PrivateFileViolation, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "PrivateFileError"
    this.reason = reason
  }
}

export const isErrnoCode = (cause: unknown, code: string): boolean =>
  Predicate.hasProperty(cause, "code") && cause.code === code

export const readRegularFile = async (
  target: string,
  maxBytes: number
): Promise<{ readonly bytes: Buffer; readonly size: number }> => {
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch((cause: unknown) => {
    if (isErrnoCode(cause, "ELOOP"))
      throw new PrivateFileError("not_regular", "path is a symlink", { cause })
    throw cause
  })
  try {
    const status = await handle.stat()
    if (!status.isFile()) throw new PrivateFileError("not_regular", "path is not a regular file")
    if (status.size > maxBytes)
      throw new PrivateFileError("too_large", "file exceeds its size limit")
    const chunks: Buffer[] = []
    let length = 0
    while (length <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - length))
      const read = await handle.read(buffer, 0, buffer.byteLength, null)
      if (read.bytesRead === 0) break
      chunks.push(buffer.subarray(0, read.bytesRead))
      length += read.bytesRead
    }
    if (length > maxBytes) throw new PrivateFileError("too_large", "file exceeds its size limit")
    return { bytes: Buffer.concat(chunks, length), size: length }
  } finally {
    await handle.close()
  }
}

export const ensurePrivateDir = async (directory: string): Promise<string | undefined> => {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 })
  const status = await lstat(directory)
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new PrivateFileError("not_directory", "private directory is not a plain directory")
  }
  await chmod(directory, 0o700)
  return created
}

export const syncDir = async (directory: string): Promise<void> => {
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export const writeNewFile = async (target: string, content: string | Uint8Array): Promise<void> => {
  const handle = await open(target, "wx", 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
}
